/* =============================================================================
 * drills.js — session state machine and question lifecycle.
 *
 * Guarantees required by spec §19:
 *   • exactly one session state: ready | running | paused | completed | cancelled
 *   • exactly one authoritative outcome per question: correct | incorrect |
 *     skipped | timedout, and a question can be finalised only once
 *   • the correct answer is authored by the generator before display; it is
 *     never derived from what the user typed
 *   • paused time is excluded from both session and response durations
 *   • countdown expiry, Enter, Skip, End Drill and per-question timeout are all
 *     funnelled through the same guarded finalise() so they cannot double-count
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.drills = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATES = {
    READY: 'ready',
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
  };

  var SESSION_TYPES = ['fixed', 'countdown', 'stopwatch', 'endless', 'untimed'];
  var DIFFICULTIES = ['easy', 'medium', 'hard'];
  var DEDUPE_ATTEMPTS = 12;

  function SM() { return (typeof globalThis !== 'undefined' ? globalThis : this).SM || {}; }
  function gen() { return SM().generators; }
  function val() { return SM().validation; }
  function timerLib() { return SM().timer; }
  function analytics() { return SM().analytics; }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  /* ------------------------------------------------------------ config */

  function normalizeConfig(cfg) {
    cfg = cfg || {};
    var out = {
      topic: cfg.topic || 'mixed',
      topics: Array.isArray(cfg.topics) ? cfg.topics.slice() : [],
      difficulty: DIFFICULTIES.indexOf(cfg.difficulty) !== -1 ? cfg.difficulty : 'medium',
      sessionType: SESSION_TYPES.indexOf(cfg.sessionType) !== -1 ? cfg.sessionType : 'fixed',
      questionCount: isInt(cfg.questionCount) ? cfg.questionCount : 10,
      durationMs: isFinite(cfg.durationMs) ? cfg.durationMs : 5 * 60 * 1000,
      answerMode: cfg.answerMode === 'mcq' ? 'mcq' : 'input',
      mcqOptionCount: isInt(cfg.mcqOptionCount) ? Math.max(2, Math.min(6, cfg.mcqOptionCount)) : 4,
      feedback: cfg.feedback === 'immediate' ? 'immediate' : 'end',
      autoAdvance: !!cfg.autoAdvance,
      autoAdvanceMs: isFinite(cfg.autoAdvanceMs) ? cfg.autoAdvanceMs : 1200,
      negativeMarking: !!cfg.negativeMarking,
      negativeFraction: isFinite(cfg.negativeFraction) ? cfg.negativeFraction : 0.25,
      perQuestionLimitMs: isFinite(cfg.perQuestionLimitMs) && cfg.perQuestionLimitMs > 0
        ? cfg.perQuestionLimitMs : null,
      topicSettings: cfg.topicSettings && typeof cfg.topicSettings === 'object' ? cfg.topicSettings : {},
      dedupe: cfg.dedupe !== false,
      adaptive: !!cfg.adaptive,
      fixedQuestions: Array.isArray(cfg.fixedQuestions) ? cfg.fixedQuestions : null,
      label: cfg.label || ''
    };
    // normalized mixed weights
    var sum = 0;
    out.topics.forEach(function (t) { sum += (isFinite(t.weight) && t.weight > 0) ? t.weight : 0; });
    out.topics = out.topics
      .filter(function (t) { return gen() && gen().getTopic(t.id); })
      .map(function (t) {
        var w = (isFinite(t.weight) && t.weight > 0) ? t.weight : 0;
        return { id: t.id, weight: sum > 0 ? w / sum : 0 };
      });
    return out;
  }

  /** Human-readable validation so the UI can explain what to fix (spec §19). */
  function validateConfig(cfg) {
    var errors = [];
    var c = normalizeConfig(cfg);

    if (c.topic === 'mixed') {
      if (!c.topics.length) errors.push('Select at least one topic for mixed practice.');
      else if (!c.topics.some(function (t) { return t.weight > 0; })) {
        errors.push('Give at least one mixed-practice topic a weight above zero.');
      }
    } else if (!gen().getTopic(c.topic)) {
      errors.push('Choose a valid topic.');
    }

    if (c.sessionType === 'fixed') {
      if (!isInt(c.questionCount) || c.questionCount < 1 || c.questionCount > 500) {
        errors.push('Question count must be a whole number between 1 and 500.');
      }
    }
    if (c.sessionType === 'countdown') {
      if (!isFinite(c.durationMs) || c.durationMs < 10000 || c.durationMs > 60 * 60 * 1000) {
        errors.push('Countdown length must be between 10 seconds and 60 minutes.');
      }
    }

    // per-topic range sanity
    if (c.topic !== 'mixed') {
      var t = gen().getTopic(c.topic);
      if (t) {
        var s = gen().sanitiseSettings(c.topic, c.topicSettings[c.topic]);
        t.settings.forEach(function (f) {
          if (f.type !== 'int') return;
          var v = s[f.key];
          if (!isFinite(v) || v < f.min || v > f.max) {
            errors.push(f.label + ' must be between ' + f.min + ' and ' + f.max + '.');
          }
        });
      }
    }

    return { valid: errors.length === 0, errors: errors };
  }

  /* ----------------------------------------------------------- session */

  function createSession(config) {
    var cfg = normalizeConfig(config);
    var now = (config && config.now) || timerLib().defaultNow;
    var questions = gen();
    var seen = {};
    var records = [];
    var state = STATES.READY;
    var completed = false;
    var expiredByCountdown = false;
    var current = null;
    var qTimer = null;
    var sessionTimer = timerLib().createTimer({ now: now });
    var index = 0;
    var pendingInput = '';
    var lastTopics = [];
    var adaptive = {
      enabled: cfg.adaptive,
      difficulty: cfg.difficulty,
      sampleCount: 0,
      sampleCorrect: 0,
      sampleMs: 0
    };

    function currentDifficulty() { return adaptive.enabled ? adaptive.difficulty : cfg.difficulty; }

    function chooseTopic() {
      if (cfg.topic !== 'mixed') return cfg.topic;
      var pool = cfg.topics.filter(function (t) { return t.weight > 0; });
      if (!pool.length) pool = cfg.topics.length ? cfg.topics : [{ id: 'addition', weight: 1 }];

      // avoid the same topic three times running when there is a choice
      var lastTwoSame = lastTopics.length >= 2 &&
        lastTopics[lastTopics.length - 1] === lastTopics[lastTopics.length - 2];
      var candidates = pool;
      if (lastTwoSame && pool.length > 1) {
        candidates = pool.filter(function (t) { return t.id !== lastTopics[lastTopics.length - 1]; });
      }
      var total = 0, i;
      for (i = 0; i < candidates.length; i++) total += candidates[i].weight;
      var r = Math.random() * total, chosen = candidates[candidates.length - 1].id;
      for (i = 0; i < candidates.length; i++) {
        r -= candidates[i].weight;
        if (r <= 0) { chosen = candidates[i].id; break; }
      }
      lastTopics.push(chosen);
      if (lastTopics.length > 4) lastTopics.shift();
      return chosen;
    }

    function buildQuestion() {
      // retry-mistakes mode re-presents the exact original questions
      if (cfg.fixedQuestions && cfg.fixedQuestions.length) {
        // index is advanced to the 1-based question number before this call
        var src = cfg.fixedQuestions[(index - 1) % cfg.fixedQuestions.length];
        var clone = JSON.parse(JSON.stringify({
          topic: src.topic, subtopic: src.subtopic, pattern: src.pattern,
          difficulty: src.difficulty, prompt: src.prompt, answer: src.answer,
          answerType: src.answerType, explanation: src.explanation, meta: src.meta || {}
        }));
        return clone;
      }

      var topicId = chooseTopic();
      var settings = cfg.topicSettings[topicId] || questions.defaultSettings(topicId, currentDifficulty());
      var q = questions.generateQuestion(topicId, settings, currentDifficulty());

      if (cfg.dedupe) {
        var tries = 0;
        while (seen[q.prompt] && tries < DEDUPE_ATTEMPTS) {
          q = questions.generateQuestion(topicId, settings, currentDifficulty());
          tries++;
        }
      }
      seen[q.prompt] = true;
      return q;
    }

    function presentCurrent() {
      index++;
      current = buildQuestion();
      current.id = 'q' + index;
      current.index = index;
      current.status = null;
      current.isRetry = !!(cfg.fixedQuestions && cfg.fixedQuestions.length);
      if (cfg.answerMode === 'mcq') {
        var opts = questions.makeOptions(current, cfg.mcqOptionCount);
        current.options = opts;
        current.correctOptionIndex = opts.reduce(function (acc, o, i) { return o.correct ? i : acc; }, -1);
      }
      pendingInput = '';
      qTimer = timerLib().createTimer({ now: now });
      qTimer.start();
      return current;
    }

    /** The single choke point for marking a question finished. Idempotent. */
    function finalise(status, submittedText) {
      if (!current || current.status !== null) return null; // already finalised
      var ms = qTimer ? Math.round(qTimer.elapsedMs()) : 0;
      if (qTimer) qTimer.stop();
      current.status = status;
      var rec = {
        id: current.id,
        index: current.index,
        topic: current.topic,
        subtopic: current.subtopic,
        pattern: current.pattern,
        difficulty: current.difficulty,
        prompt: current.prompt,
        answer: current.answer,
        correctText: questions.answerText(current.answer),
        explanation: current.explanation,
        answerType: current.answerType,
        options: current.options || null,
        correctOptionIndex: current.correctOptionIndex == null ? -1 : current.correctOptionIndex,
        status: status,
        submittedText: submittedText == null ? '' : String(submittedText),
        responseMs: ms,
        isRetry: current.isRetry
      };
      records.push(rec);
      if (adaptive.enabled && (status === 'correct' || status === 'incorrect')) {
        adaptive.sampleCount++;
        adaptive.sampleMs += ms;
        if (status === 'correct') adaptive.sampleCorrect++;
        maybeAdapt();
      }
      return rec;
    }

    function maybeAdapt() {
      if (adaptive.sampleCount < 5) return;   // minimum sample before changing (§12)
      var acc = adaptive.sampleCorrect / adaptive.sampleCount;
      var avgMs = adaptive.sampleMs / adaptive.sampleCount;
      var idx = DIFFICULTIES.indexOf(adaptive.difficulty);
      var changed = false;
      if (acc >= 0.8 && avgMs < 12000 && idx < DIFFICULTIES.length - 1) {
        adaptive.difficulty = DIFFICULTIES[idx + 1]; changed = true;
      } else if (acc < 0.5 && idx > 0) {
        adaptive.difficulty = DIFFICULTIES[idx - 1]; changed = true;
      }
      if (changed) { adaptive.sampleCount = 0; adaptive.sampleCorrect = 0; adaptive.sampleMs = 0; }
    }

    function shouldEndAfterFinal() {
      if (cfg.fixedQuestions && cfg.fixedQuestions.length) {
        return records.length >= cfg.fixedQuestions.length;
      }
      return cfg.sessionType === 'fixed' && records.length >= cfg.questionCount;
    }

    function complete() {
      if (completed) return;                  // end exactly once
      completed = true;
      if (sessionTimer.isRunning()) sessionTimer.stop();
      if (qTimer && qTimer.isRunning()) qTimer.stop();
      state = STATES.COMPLETED;
    }

    var session = {
      getState: function () { return state; },
      getConfig: function () { return cfg; },

      start: function () {
        if (state !== STATES.READY) return false;
        state = STATES.RUNNING;
        sessionTimer.start();
        presentCurrent();
        return true;
      },

      pause: function () {
        if (state !== STATES.RUNNING) return false;
        sessionTimer.pause();
        if (qTimer) qTimer.pause();
        state = STATES.PAUSED;
        return true;
      },

      resume: function () {
        if (state !== STATES.PAUSED) return false;
        sessionTimer.resume();
        if (qTimer) qTimer.resume();
        state = STATES.RUNNING;
        return true;
      },

      currentQuestion: function () { return current; },

      /** Keep the latest typed text so an auto-timeout can show what was typed. */
      setPendingInput: function (text) { pendingInput = text == null ? '' : String(text); },

      submit: function (input) {
        if (state !== STATES.RUNNING || !current || current.status !== null) {
          return { ok: false, reason: 'already-finalized' };
        }
        if (cfg.answerMode === 'mcq') {
          var idx = isInt(input) ? input : parseFloat(input);
          if (!isInt(idx) || idx < 0 || idx >= current.options.length) {
            return { ok: false, status: 'invalid', reason: 'Choose one of the options.' };
          }
          var opt = current.options[idx];
          var st = opt.correct ? 'correct' : 'incorrect';
          finalise(st, opt.text);
          return { ok: true, status: st, correctText: questions.answerText(current.answer) };
        }
        var verdict = val().check(input, current);
        if (verdict.status === 'invalid') {
          // empty/malformed input is not a wrong answer (spec §6)
          return { ok: false, status: 'invalid', reason: verdict.reason || 'Check your answer.' };
        }
        finalise(verdict.status, input);
        return { ok: true, status: verdict.status, correctText: questions.answerText(current.answer) };
      },

      skip: function () {
        if (state !== STATES.RUNNING || !current || current.status !== null) return { ok: false };
        finalise('skipped', '');
        return { ok: true, status: 'skipped' };
      },

      /** Per-question timeout (only fires when a limit is configured). */
      timeoutQuestion: function () {
        if (state !== STATES.RUNNING || !current || current.status !== null) return { ok: false };
        finalise('timedout', pendingInput);
        return { ok: true, status: 'timedout' };
      },

      next: function () {
        if (state === STATES.COMPLETED || state === STATES.CANCELLED) return { ok: false, done: true };
        if (!current || current.status === null) return { ok: false, reason: 'current-not-finalized' };
        if (shouldEndAfterFinal()) { complete(); return { ok: true, done: true }; }
        presentCurrent();
        return { ok: true, done: false };
      },

      /** Periodic heartbeat: enforces countdown expiry and per-question limits. */
      tick: function (partialText) {
        if (typeof partialText === 'string') pendingInput = partialText;
        // Once a countdown has expired the session stays expired: repeated ticks
        // keep reporting it so a polling caller cannot miss the signal.
        if (state !== STATES.RUNNING) return { expired: expiredByCountdown, questionTimedOut: false };
        var out = { expired: false, questionTimedOut: false };

        if (cfg.perQuestionLimitMs && current && current.status === null &&
            qTimer && qTimer.elapsedMs() >= cfg.perQuestionLimitMs) {
          finalise('timedout', pendingInput);
          out.questionTimedOut = true;
        }

        if (cfg.sessionType === 'countdown' && sessionTimer.elapsedMs() >= cfg.durationMs) {
          // Documented policy: the active question is recorded as timed out, then
          // the session ends exactly once.
          if (current && current.status === null) finalise('timedout', pendingInput);
          expiredByCountdown = true;
          complete();
          out.expired = true;
        }
        return out;
      },

      /** Manual "End drill" — always yields a valid report for what was shown. */
      end: function () {
        if (state === STATES.COMPLETED || state === STATES.CANCELLED) {
          return { ok: false, state: state };
        }
        if (current && current.status === null) finalise('skipped', pendingInput);
        complete();
        return { ok: true, state: state };
      },

      /** Abandon without producing results (used after an explicit confirmation). */
      cancel: function () {
        if (state === STATES.COMPLETED) return false;
        if (sessionTimer.isRunning()) sessionTimer.stop();
        if (qTimer && qTimer.isRunning()) qTimer.stop();
        state = STATES.CANCELLED;
        return true;
      },

      elapsedMs: function () { return sessionTimer.elapsedMs(); },
      isPaused: function () { return sessionTimer.isPaused(); },
      remainingMs: function () {
        if (cfg.sessionType !== 'countdown') return null;
        return Math.max(0, cfg.durationMs - sessionTimer.elapsedMs());
      },
      currentQuestionElapsedMs: function () { return qTimer ? qTimer.elapsedMs() : 0; },

      getRecords: function () { return records.slice(); },
      getCurrentDifficulty: function () { return currentDifficulty(); },
      getProgress: function () {
        return {
          index: index,
          answeredRecords: records.length,
          total: cfg.fixedQuestions ? cfg.fixedQuestions.length
               : (cfg.sessionType === 'fixed' ? cfg.questionCount : null),
          runningCorrect: records.filter(function (r) { return r.status === 'correct'; }).length,
          runningIncorrect: records.filter(function (r) { return r.status === 'incorrect'; }).length
        };
      },

      isComplete: function () { return state === STATES.COMPLETED; },

      getResults: function () {
        return analytics().computeResults(records, {
          sessionMs: sessionTimer.elapsedMs(),
          negativeMarking: cfg.negativeMarking,
          negativeFraction: cfg.negativeFraction
        });
      }
    };

    return session;
  }

  /** Build a retry session from the mistakes of a previous result set. */
  function createRetrySession(records, baseConfig) {
    var mistakes = analytics().mistakeRecords(records);
    if (!mistakes.length) return null;
    var cfg = Object.assign({}, baseConfig || {}, {
      sessionType: 'fixed',
      questionCount: mistakes.length,
      fixedQuestions: mistakes.map(function (r) {
        return {
          topic: r.topic, subtopic: r.subtopic, pattern: r.pattern, difficulty: r.difficulty,
          prompt: r.prompt, answer: r.answer, answerType: r.answerType,
          explanation: r.explanation, meta: r.meta || {}
        };
      }),
      label: 'Retry mistakes',
      dedupe: false
    });
    return createSession(cfg);
  }

  return {
    STATES: STATES,
    SESSION_TYPES: SESSION_TYPES,
    DIFFICULTIES: DIFFICULTIES,
    normalizeConfig: normalizeConfig,
    validateConfig: validateConfig,
    createSession: createSession,
    createRetrySession: createRetrySession
  };
});
