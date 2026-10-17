/* =============================================================================
 * tests/cases.js — shared test cases for the pure engine.
 *
 * Exports an array of { name, fn(assert) }. The same cases are executed by
 * `node --test` (tests/engine.test.js) and by the in-browser page
 * (tests/tests.html), so a single definition covers both.
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.testCases = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sm() { return (typeof globalThis !== 'undefined' ? globalThis : this).SM; }
  function G() { return sm().generators; }
  function V() { return sm().validation; }
  function T() { return sm().timer; }
  function AN() { return sm().analytics; }
  function D() { return sm().drills; }

  var cases = [];
  function t(name, fn) { cases.push({ name: name, fn: fn }); }
  function fakeClock() {
    var t0 = 0;
    return { now: function () { return t0; }, advance: function (ms) { t0 += ms; }, set: function (ms) { t0 = ms; } };
  }

  /* ==================================================== question generation */

  t('every topic generates structurally valid questions at every difficulty', function (a) {
    var bad = [];
    G().listTopics().forEach(function (topic) {
      ['easy', 'medium', 'hard'].forEach(function (diff) {
        var s = G().defaultSettings(topic.id, diff);
        for (var i = 0; i < 60; i++) {
          var q = G().generateQuestion(topic.id, s, diff);
          if (!G().validateQuestion(q)) bad.push(topic.id + '/' + diff + ': ' + JSON.stringify(q));
        }
      });
    });
    a.equal(bad.length, 0, 'invalid questions: ' + bad.slice(0, 3).join(' | '));
  });

  t('no topic silently falls back to the emergency question', function (a) {
    // generateQuestion() catches any generator error and, after 12 tries,
    // substitutes a trivial "7 + 8". That fallback is a valid question, so only
    // an explicit check catches a generator that has quietly stopped working.
    var offenders = {};
    G().listTopics().forEach(function (topic) {
      ['easy', 'medium', 'hard'].forEach(function (diff) {
        var s = G().defaultSettings(topic.id, diff);
        for (var i = 0; i < 120; i++) {
          var q = G().generateQuestion(topic.id, s, diff);
          // The emergency fallback returns topic 'addition' regardless of what was
          // asked for. Intra-topic fallbacks (e.g. mixed-arithmetic) are fine.
          if (q.topic !== topic.id) offenders[topic.id + '/' + diff] = true;
        }
      });
    });
    a.equal(Object.keys(offenders).length, 0, 'fallback used by: ' + Object.keys(offenders).join(', '));
  });

  t('fraction arithmetic returns fractions at every difficulty', function (a) {
    ['easy', 'medium', 'hard'].forEach(function (diff) {
      var s = G().defaultSettings('fraction-arithmetic', diff);
      for (var i = 0; i < 60; i++) {
        var q = G().generateQuestion('fraction-arithmetic', s, diff);
        a.equal(q.answer.type, 'fraction', diff + ' should give a fraction answer: ' + q.prompt);
        a.ok(/[0-9]/.test(q.prompt), 'prompt should contain the fractions: ' + q.prompt);
      }
    });
  });

  t('percentage → fraction is mathematically exact (including recurring percentages)', function (a) {
    // "33 1/3% as a fraction in lowest terms" must really equal 1/3, i.e. the
    // percentage printed in the prompt has to match the answer as a rational.
    function parsePercent(text) {
      var m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);          // "33 1/3"
      if (m) return { n: Number(m[1]) * Number(m[3]) + Number(m[2]), d: Number(m[3]) * 100 };
      m = /^(\d+)\/(\d+)$/.exec(text);                       // "1/2"
      if (m) return { n: Number(m[1]), d: Number(m[2]) * 100 };
      m = /^([\d.]+)$/.exec(text);                           // "12.5" / "25"
      if (m) { var dp = (m[1].split('.')[1] || '').length; var f = Math.pow(10, dp);
               return { n: Math.round(Number(m[1]) * f), d: f * 100 }; }
      return null;
    }
    ['easy', 'medium', 'hard'].forEach(function (diff) {
      var s = G().defaultSettings('percent-to-fraction', diff);
      for (var i = 0; i < 200; i++) {
        var q = G().generateQuestion('percent-to-fraction', s, diff);
        var m = /^(.+)% as a fraction in lowest terms$/.exec(q.prompt);
        a.ok(m, 'unexpected prompt: ' + q.prompt);
        var p = parsePercent(m[1]);
        a.ok(p, 'unparseable percentage: ' + q.prompt);
        a.equal(p.n * q.answer.den, q.answer.num * p.d,
          'printed percentage must equal the answer fraction: ' + q.prompt + ' -> ' + q.answer.num + '/' + q.answer.den);
      }
    });
  });

  t('fraction → percentage answers are exactly the stated rounding', function (a) {
    ['easy', 'medium', 'hard'].forEach(function (diff) {
      var s = G().defaultSettings('fraction-to-percent', diff);
      for (var i = 0; i < 200; i++) {
        var q = G().generateQuestion('fraction-to-percent', s, diff);
        var m = /^(\d+)\/(\d+) as a percentage/.exec(q.prompt);
        a.ok(m, 'unexpected prompt: ' + q.prompt);
        var exact = Number(m[1]) / Number(m[2]) * 100;
        var tol = Math.pow(10, -q.answer.places) / 2 + 1e-9;
        a.ok(Math.abs(exact - q.answer.value) <= tol,
          q.prompt + ' should round to ' + q.answer.value + ' (exact ' + exact + ')');
      }
    });
  });

  t('every generated answer round-trips through its own validator', function (a) {
    var bad = [];
    G().listTopics().forEach(function (topic) {
      ['easy', 'medium', 'hard'].forEach(function (diff) {
        var s = G().defaultSettings(topic.id, diff);
        for (var i = 0; i < 60; i++) {
          var q = G().generateQuestion(topic.id, s, diff);
          var text = G().answerText(q.answer);
          var verdict = V().check(text, q);
          if (verdict.status !== 'correct') bad.push(topic.id + '/' + diff + ' "' + q.prompt + '" ans=' + text + ' -> ' + verdict.status);
        }
      });
    });
    a.equal(bad.length, 0, 'mismatches: ' + bad.slice(0, 3).join(' | '));
  });

  t('difficulty changes the pattern set, not just the size of numbers', function (a) {
    function patterns(topic, diff, n) {
      var s = G().defaultSettings(topic, diff), set = {};
      for (var i = 0; i < n; i++) set[G().generateQuestion(topic, s, diff).subtopic] = true;
      return Object.keys(set);
    }
    var squaresEasy = patterns('squares', 'easy', 200);
    var squaresHard = patterns('squares', 'hard', 300);
    a.ok(squaresEasy.indexOf('near-50') === -1, 'easy squares should not use the near-50 pattern');
    a.ok(squaresHard.indexOf('near-50') !== -1, 'hard squares should use the near-50 pattern');

    var bodmasEasy = patterns('bodmas', 'easy', 120);
    var bodmasHard = patterns('bodmas', 'hard', 200);
    a.ok(bodmasEasy.indexOf('simplify-fallback') !== -1 || bodmasHard.length >= 1, 'bodmas produces questions');
  });

  t('division never divides by zero and keeps remainder below the divisor', function (a) {
    var s = G().defaultSettings('division', 'hard');
    for (var i = 0; i < 400; i++) {
      var q = G().generateQuestion('division', s, 'hard');
      a.ok(q.meta.divisor !== 0, 'divisor must not be zero: ' + q.prompt);
      a.ok(q.answer.remainder >= 0 && q.answer.remainder < q.meta.divisor,
        'remainder out of range: ' + q.prompt + ' r=' + q.answer.remainder);
      a.equal(q.meta.dividend, q.meta.divisor * q.meta.quotient + q.answer.remainder,
        'dividend must equal divisor*quotient+remainder: ' + q.prompt);
    }
    var se = G().defaultSettings('division', 'easy');
    for (var j = 0; j < 200; j++) {
      var q2 = G().generateQuestion('division', se, 'easy');
      a.equal(q2.answer.remainder, 0, 'exact mode must have zero remainder: ' + q2.prompt);
    }
  });

  t('square-root and cube-root drills show exact perfect powers', function (a) {
    var ss = G().defaultSettings('squareroot', 'medium');
    for (var i = 0; i < 200; i++) {
      var q = G().generateQuestion('squareroot', ss, 'medium');
      var n = q.answer.value;
      a.equal(q.meta.radicand, n * n, 'radicand must be a perfect square: ' + q.prompt);
      a.equal(Math.round(Math.sqrt(q.meta.radicand)), n, 'answer must be the exact root');
    }
    var cs = G().defaultSettings('cuberoot', 'hard');
    for (var j = 0; j < 200; j++) {
      var q2 = G().generateQuestion('cuberoot', cs, 'hard');
      var m = q2.answer.value;
      a.equal(q2.meta.radicand, m * m * m, 'radicand must be a perfect cube: ' + q2.prompt);
    }
  });

  t('BODMAS keeps every intermediate integer, non-negative and bounded', function (a) {
    var s = G().defaultSettings('bodmas', 'hard');
    for (var i = 0; i < 250; i++) {
      var q = G().generateQuestion('bodmas', s, 'hard');
      a.ok(q.meta.tokens, 'bodmas question should carry its tokens');
      var r = G().evaluateTokens(q.meta.tokens);
      a.ok(r !== null, 'tokens must evaluate: ' + q.prompt);
      a.ok(r.allInt, 'no fractional intermediate in: ' + q.prompt);
      a.ok(r.value >= 0, 'answer must not be negative: ' + q.prompt);
      a.ok(r.maxAbs <= 50000, 'magnitude must stay reasonable: ' + q.prompt);
      a.equal(r.value, q.answer.value, 'evaluated value must equal the stored answer: ' + q.prompt);
    }
  });

  t('percentages are always written with a % sign (never a bare "x of y")', function (a) {
    var topics = ['bodmas', 'mixed-arithmetic', 'percentage'];
    var offenders = [];
    topics.forEach(function (topic) {
      ['easy', 'medium', 'hard'].forEach(function (diff) {
        var s = G().defaultSettings(topic, diff);
        for (var i = 0; i < 150; i++) {
          var prompt = G().generateQuestion(topic, s, diff).prompt;
          var re = /(\d+)\s+of\b/g, m;
          while ((m = re.exec(prompt)) !== null) {
            var before = prompt.charAt(m.index - 1);
            if (before !== '%' && before !== '/') offenders.push(topic + ': ' + prompt);
          }
        }
      });
    });
    a.equal(offenders.length, 0, 'bare "of" found: ' + offenders.slice(0, 3).join(' | '));
  });

  t('explanations are consistent with the answer they describe', function (a) {
    var offenders = [];
    G().listTopics().forEach(function (topic) {
      ['easy', 'medium', 'hard'].forEach(function (diff) {
        var s = G().defaultSettings(topic.id, diff);
        for (var i = 0; i < 40; i++) {
          var q = G().generateQuestion(topic.id, s, diff);
          if (q.explanation && q.answer.type === 'integer') {
            if (q.explanation.indexOf(String(q.answer.value)) === -1) {
              offenders.push(topic + '/' + diff + ': "' + q.prompt + '" = ' + q.answer.value + ' :: ' + q.explanation);
            }
          }
        }
      });
    });
    a.equal(offenders.length, 0, 'explanation/answer mismatch: ' + offenders.slice(0, 2).join(' | '));
  });

  t('out-of-range settings are clamped rather than trusted', function (a) {
    var s = G().sanitiseSettings('multiplication', { digitA: 99, digitB: -5 });
    var topic = G().getTopic('multiplication');
    a.equal(s.digitA, 4, 'digitA clamped to max');
    a.equal(s.digitB, 1, 'digitB clamped to min');
    var s2 = G().sanitiseSettings('tables', { tableMin: 20, tableMax: 5 });
    a.ok(s2.tableMax >= s2.tableMin, 'tableMax must not be below tableMin');
    a.ok(topic.settings.length > 0);
  });

  t('duplicate avoidance terminates on a tiny question space', function (a) {
    // table of 2 only, multiplied by 2..5 → only four distinct questions
    var s = G().sanitiseSettings('tables', { tableMin: 2, tableMax: 2, multMax: 5 });
    var started = Date.now();
    for (var i = 0; i < 400; i++) {
      a.ok(G().validateQuestion(G().generateQuestion('tables', s, 'easy')));
    }
    a.ok(Date.now() - started < 4000, 'generation must not hang');
  });

  t('a large question space is effectively unlimited', function (a) {
    var s = G().defaultSettings('addition', 'hard');
    var seen = {};
    for (var i = 0; i < 400; i++) seen[G().generateQuestion('addition', s, 'hard').prompt] = true;
    a.ok(Object.keys(seen).length > 350, 'expected mostly-distinct questions, got ' + Object.keys(seen).length);
  });

  t('MCQ options: correct count, one correct answer, all distinct', function (a) {
    G().listTopics().forEach(function (topic) {
      var s = G().defaultSettings(topic.id, 'medium');
      for (var i = 0; i < 25; i++) {
        var q = G().generateQuestion(topic.id, s, 'medium');
        var opts = G().makeOptions(q, 4);
        a.equal(opts.length, 4, topic.id + ' should have 4 options');
        a.equal(opts.filter(function (o) { return o.correct; }).length, 1, topic.id + ' must have exactly one correct option');
        var texts = opts.map(function (o) { return o.text; });
        a.equal(new Set(texts).size, 4, topic.id + ' options must be distinct: ' + texts.join(', '));
        var correct = opts.filter(function (o) { return o.correct; })[0];
        a.equal(correct.text, G().answerText(q.answer), 'correct option must equal the answer text');
      }
    });
  });

  t('invalid topic and unsafe settings fall back safely', function (a) {
    a.throws(function () { G().generateQuestion('not-a-topic', {}, 'easy'); });
    // empty settings must still yield valid questions using defaults
    a.ok(G().validateQuestion(G().generateQuestion('percentage', {}, 'medium')));
    a.ok(G().validateQuestion(G().generateQuestion('bodmas', null, 'hard')));
  });

  /* ======================================================== validation */

  t('integer answers: exact match, tolerance for ".0", reject junk', function (a) {
    var q = { answer: { type: 'integer', value: 1440 } };
    a.equal(V().check('1440', q).status, 'correct');
    a.equal(V().check('1440.0', q).status, 'correct');
    a.equal(V().check('1,440', q).status, 'correct');
    a.equal(V().check('1441', q).status, 'incorrect');
    a.equal(V().check('abc', q).status, 'invalid');
    a.equal(V().check('', q).status, 'invalid');
    a.equal(V().check('   ', q).status, 'invalid');
    a.equal(V().check(null, q).status, 'invalid');
  });

  t('decimal answers use a precision-based tolerance', function (a) {
    var q = { answer: { type: 'decimal', value: 12.5, places: 1 } };
    a.equal(V().check('12.5', q).status, 'correct');
    a.equal(V().check('12.50', q).status, 'correct');
    a.equal(V().check('12.6', q).status, 'incorrect');
    a.equal(V().check('0.30000000000000004', { answer: { type: 'decimal', value: 0.3, places: 1 } }).status, 'correct');
  });

  t('percentage answers accept both "25" and "25%"', function (a) {
    var q = { answer: { type: 'percentage', value: 25, places: 1 } };
    a.equal(V().check('25', q).status, 'correct');
    a.equal(V().check('25%', q).status, 'correct');
    a.equal(V().check(' 25 % ', q).status, 'correct');
    a.equal(V().check('26', q).status, 'incorrect');
    a.equal(V().check('x%', q).status, 'invalid');
  });

  t('equivalent fractions are accepted; simplification is enforced when asked', function (a) {
    var loose = { answer: { type: 'fraction', num: 3, den: 4, requireSimplified: false } };
    a.equal(V().check('3/4', loose).status, 'correct');
    a.equal(V().check('6/8', loose).status, 'correct');
    a.equal(V().check('9/12', loose).status, 'correct');
    a.equal(V().check('2/3', loose).status, 'incorrect');

    var strict = { answer: { type: 'fraction', num: 3, den: 4, requireSimplified: true } };
    a.equal(V().check('3/4', strict).status, 'correct');
    var v = V().check('6/8', strict);
    a.equal(v.status, 'incorrect');
    a.ok(/lowest terms/.test(v.reason), 'reason should explain the simplification requirement');

    // a fraction drill that reduces to a whole number accepts the integer form,
    // but an equivalent fraction still has to be in lowest terms
    var whole = { answer: { type: 'fraction', num: 1, den: 1, requireSimplified: true } };
    a.equal(V().check('1', whole).status, 'correct');
    var wv = V().check('2/2', whole);
    a.equal(wv.status, 'incorrect', 'a whole-number fraction must still be in lowest terms');
    a.ok(/lowest terms/.test(wv.reason), 'reason should explain the simplification requirement');
  });

  t('fractions reject a zero denominator instead of dividing by zero', function (a) {
    var q = { answer: { type: 'fraction', num: 1, den: 2, requireSimplified: false } };
    a.equal(V().check('3/0', q).status, 'invalid');
  });

  t('division answers accept quotient + remainder, and only when needed', function (a) {
    var withR = { answer: { type: 'division', quotient: 17, remainder: 3 } };
    a.equal(V().check('17 R 3', withR).status, 'correct');
    a.equal(V().check('17 r3', withR).status, 'correct');
    a.equal(V().check('17 remainder 3', withR).status, 'correct');
    a.equal(V().check('17', withR).status, 'incorrect');
    a.equal(V().check('17 R 4', withR).status, 'incorrect');
    a.equal(V().check('nonsense', withR).status, 'invalid');

    var exact = { answer: { type: 'division', quotient: 24, remainder: 0 } };
    a.equal(V().check('24', exact).status, 'correct');
    a.equal(V().check('24 R 0', exact).status, 'correct');
    a.equal(V().check('23', exact).status, 'incorrect');
  });

  t('answerToText renders each answer type canonically', function (a) {
    a.equal(V().answerToText({ type: 'integer', value: 42 }), '42');
    a.equal(V().answerToText({ type: 'decimal', value: 12.5, places: 1 }), '12.5');
    a.equal(V().answerToText({ type: 'percentage', value: 12.5, places: 1 }), '12.5%');
    a.equal(V().answerToText({ type: 'fraction', num: 3, den: 4 }), '3/4');
    a.equal(V().answerToText({ type: 'fraction', num: 5, den: 1 }), '5');
    a.equal(V().answerToText({ type: 'division', quotient: 7, remainder: 2 }), '7 R 2');
  });

  /* ============================================================== timer */

  t('stopwatch records elapsed time from timestamps', function (a) {
    var c = fakeClock();
    var timer = T().createTimer({ now: c.now });
    timer.start();
    c.advance(1500);
    a.equal(timer.elapsedMs(), 1500);
    c.advance(500);
    a.equal(timer.elapsedMs(), 2000);
  });

  t('pause excludes paused time from the elapsed duration', function (a) {
    var c = fakeClock();
    var timer = T().createTimer({ now: c.now });
    timer.start();
    c.advance(1000);
    timer.pause();
    c.advance(9000);              // nine seconds while paused
    a.equal(timer.elapsedMs(), 1000, 'paused time must not be counted');
    timer.resume();
    c.advance(500);
    a.equal(timer.elapsedMs(), 1500);
  });

  t('countdown reaches zero and reports expiry exactly once', function (a) {
    var c = fakeClock();
    var timer = T().createTimer({ now: c.now, direction: 'down', durationMs: 5000 });
    timer.start();
    c.advance(2000);
    a.equal(timer.remainingMs(), 3000);
    a.equal(timer.isExpired(), false);
    c.advance(3000);
    a.equal(timer.remainingMs(), 0);
    a.equal(timer.isExpired(), true);
    c.advance(10000);
    a.equal(timer.remainingMs(), 0, 'remaining must clamp at zero, never go negative');
  });

  t('a stopped timer cannot be resumed', function (a) {
    var c = fakeClock();
    var timer = T().createTimer({ now: c.now });
    timer.start();
    c.advance(400);
    timer.stop();
    c.advance(1000);
    a.equal(timer.elapsedMs(), 400);
    timer.resume();
    c.advance(1000);
    a.equal(timer.elapsedMs(), 400, 'stopped timers stay frozen');
  });

  t('durations are formatted for display, and never show negative values', function (a) {
    a.equal(T().formatDuration(0), '0:00');
    a.equal(T().formatDuration(7000), '0:07');
    a.equal(T().formatDuration(161000), '2:41');
    a.equal(T().formatDuration(3725000), '1:02:05');
    a.equal(T().formatDuration(-500), '0:00');
    a.equal(T().formatResponseTime(-1), '—');
    a.equal(T().formatResponseTime(3400), '3.4s');
  });

  /* ========================================================== analytics */

  t('core metrics match a hand-calculated example', function (a) {
    var records = [
      { index: 1, topic: 'addition', status: 'correct', responseMs: 1000 },
      { index: 2, topic: 'addition', status: 'correct', responseMs: 2000 },
      { index: 3, topic: 'addition', status: 'correct', responseMs: 3000 },
      { index: 4, topic: 'division', status: 'incorrect', responseMs: 4000 },
      { index: 5, topic: 'division', status: 'skipped', responseMs: 9000 }
    ];
    var r = AN().computeResults(records, { sessionMs: 60000 });
    a.equal(r.presented, 5);
    a.equal(r.answered, 4, 'answered = correct + incorrect only');
    a.equal(r.correct, 3);
    a.equal(r.incorrect, 1);
    a.equal(r.skipped, 1);
    a.equal(r.accuracy, 75, '3/4 × 100');
    a.equal(r.correctOfPresented, 60, '3/5 × 100');
    a.equal(r.avgResponseMs, 2500, '(1000+2000+3000+4000)/4 — skipped excluded');
    a.equal(r.attemptsPerMin, 4, '4 answered in one minute');
    a.equal(r.correctPerMin, 3);
    a.equal(r.score, 3, 'no negative marking by default');
  });

  t('negative marking reduces the score by the configured fraction', function (a) {
    var records = [
      { index: 1, topic: 't', status: 'correct', responseMs: 1000 },
      { index: 2, topic: 't', status: 'correct', responseMs: 1000 },
      { index: 3, topic: 't', status: 'incorrect', responseMs: 1000 },
      { index: 4, topic: 't', status: 'incorrect', responseMs: 1000 }
    ];
    var r = AN().computeResults(records, { sessionMs: 60000, negativeMarking: true, negativeFraction: 0.25 });
    a.equal(r.score, 1.5, '2 correct − 2 × 0.25');
  });

  t('zero questions produce nulls, never NaN or Infinity', function (a) {
    var r = AN().computeResults([], { sessionMs: 0 });
    ['accuracy', 'correctOfPresented', 'avgResponseMs', 'attemptsPerMin', 'correctPerMin'].forEach(function (k) {
      a.equal(r[k], null, k + ' should be null when there is no data');
    });
    a.equal(r.hasData, false);
    a.ok(!/NaN|Infinity/.test(JSON.stringify(r)), 'result must not leak NaN/Infinity');
  });

  t('a drill with no answered questions has no accuracy or average time', function (a) {
    var records = [
      { index: 1, topic: 't', status: 'skipped', responseMs: 2000 },
      { index: 2, topic: 't', status: 'timedout', responseMs: 5000 }
    ];
    var r = AN().computeResults(records, { sessionMs: 10000 });
    a.equal(r.answered, 0);
    a.equal(r.accuracy, null, 'accuracy needs at least one answered question');
    a.equal(r.avgResponseMs, null);
    a.equal(r.correctOfPresented, 0);
    a.equal(r.skipped, 1);
    a.equal(r.timedOut, 1);
    a.equal(r.score, 0);
  });

  t('topic-wise totals for mixed drills are correct', function (a) {
    var records = [
      { index: 1, topic: 'addition', status: 'correct', responseMs: 1000 },
      { index: 2, topic: 'addition', status: 'incorrect', responseMs: 3000 },
      { index: 3, topic: 'division', status: 'correct', responseMs: 2000 },
      { index: 4, topic: 'division', status: 'correct', responseMs: 4000 }
    ];
    var r = AN().computeResults(records, { sessionMs: 60000 });
    var add = r.topicWise.filter(function (x) { return x.topic === 'addition'; })[0];
    var div = r.topicWise.filter(function (x) { return x.topic === 'division'; })[0];
    a.equal(add.presented, 2);
    a.equal(add.accuracy, 50);
    a.equal(add.avgResponseMs, 2000);
    a.equal(div.presented, 2);
    a.equal(div.accuracy, 100);
    a.equal(div.avgResponseMs, 3000);
  });

  t('review filters and mistake selection behave correctly', function (a) {
    var records = [
      { index: 1, topic: 't', status: 'correct', responseMs: 1000 },
      { index: 2, topic: 't', status: 'incorrect', responseMs: 9000 },
      { index: 3, topic: 't', status: 'skipped', responseMs: 100 },
      { index: 4, topic: 't', status: 'timedout', responseMs: 5000 }
    ];
    a.equal(AN().filterRecords(records, 'incorrect').length, 1);
    a.equal(AN().filterRecords(records, 'skipped').length, 1);
    a.equal(AN().filterRecords(records, 'timedout').length, 1);
    a.equal(AN().filterRecords(records, 'slow', 4000).length, 2, '9000 and 5000 exceed 4000');
    a.equal(AN().filterRecords(records, 'all').length, 4);
    a.equal(AN().mistakeRecords(records).length, 3, 'incorrect + skipped + timed out');
  });

  /* ============================================================= drills */

  t('a question is finalised exactly once (double submit is ignored)', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 3, now: c.now });
    s.start();
    var q = s.currentQuestion();
    var first = s.submit(G().answerText(q.answer));
    a.equal(first.ok, true);
    var second = s.submit(G().answerText(q.answer));
    a.equal(second.ok, false);
    a.equal(second.reason, 'already-finalized');
    a.equal(s.getRecords().length, 1, 'the question must be recorded once');
  });

  t('empty and malformed input is not scored as wrong', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 3, now: c.now });
    s.start();
    a.equal(s.submit('').ok, false);
    a.equal(s.submit('').status, 'invalid');
    a.equal(s.submit('hello').ok, false);
    a.equal(s.getRecords().length, 0, 'nothing recorded yet');
    a.equal(s.getState(), D().STATES.RUNNING, 'the session keeps running');
    a.equal(s.currentQuestion().status, null, 'the question is still open');
  });

  t('incorrect, skipped and timed-out questions keep their correct answer', function (a) {
    var c = fakeClock();
    var s = D().createSession({
      topic: 'addition', difficulty: 'easy', sessionType: 'fixed',
      questionCount: 3, perQuestionLimitMs: 1000, now: c.now
    });
    s.start();

    var q1 = s.currentQuestion();
    var right1 = G().answerText(q1.answer);
    s.submit(String(Number(right1) + 1));

    s.next();
    var q2 = s.currentQuestion();
    var right2 = G().answerText(q2.answer);
    s.skip();

    s.next();
    var q3 = s.currentQuestion();
    var right3 = G().answerText(q3.answer);
    c.advance(1200);
    s.tick();

    var recs = s.getRecords();
    a.equal(recs.length, 3);
    a.equal(recs[0].status, 'incorrect');
    a.equal(recs[0].correctText, right1, 'incorrect question stores its correct answer');
    a.equal(recs[1].status, 'skipped');
    a.equal(recs[1].correctText, right2, 'skipped question stores its correct answer');
    a.equal(recs[2].status, 'timedout');
    a.equal(recs[2].correctText, right3, 'timed-out question stores its correct answer');
  });

  t('a skipped question cannot be scored later', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 2, now: c.now });
    s.start();
    s.skip();
    var res = s.submit('123');
    a.equal(res.ok, false, 'a finalised question rejects further submissions');
    a.equal(s.getRecords()[0].status, 'skipped');
  });

  t('a countdown expiring records the active question as timed out and ends once', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'countdown', durationMs: 1000, now: c.now });
    s.start();
    c.advance(1100);
    var r1 = s.tick();
    a.equal(r1.expired, true);
    a.equal(s.getState(), D().STATES.COMPLETED);
    a.equal(s.getRecords().length, 1);
    a.equal(s.getRecords()[0].status, 'timedout', 'active question is recorded as timed out');
    // a second tick must not add another record or change the state
    var r2 = s.tick();
    a.equal(r2.expired, true);
    a.equal(s.getRecords().length, 1, 'completion must not double-count');
  });

  t('pausing on the last second of a countdown freezes expiry until resume', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'countdown', durationMs: 1000, now: c.now });
    s.start();
    c.advance(900);
    s.pause();
    c.advance(5000);
    a.equal(s.tick().expired, false, 'a paused countdown must not expire');
    a.equal(s.getState(), D().STATES.PAUSED);
    s.resume();
    c.advance(200);
    a.equal(s.tick().expired, true, 'resuming past the limit expires the session');
    a.equal(s.getState(), D().STATES.COMPLETED);
  });

  t('paused time is excluded from session and question durations', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 2, now: c.now });
    s.start();
    c.advance(1000);
    s.pause();
    c.advance(60000);
    s.resume();
    c.advance(500);
    var q = s.currentQuestion();
    s.submit(G().answerText(q.answer));
    a.equal(s.getRecords()[0].responseMs, 1500, '60s of pause must not be counted');
    s.end();
    a.equal(s.getResults().totalMs, 1500, 'session time excludes paused time');
  });

  t('per-question time limits finalise the question as timed out', function (a) {
    var c = fakeClock();
    var s = D().createSession({
      topic: 'addition', difficulty: 'easy', sessionType: 'endless',
      perQuestionLimitMs: 1000, now: c.now
    });
    s.start();
    c.advance(1200);
    var r = s.tick();
    a.equal(r.questionTimedOut, true);
    a.equal(s.getRecords()[0].status, 'timedout');
    a.equal(s.currentQuestion().status, 'timedout');
  });

  t('MCQ mode selects by option and marks exactly one correct option', function (a) {
    var c = fakeClock();
    var s = D().createSession({
      topic: 'multiplication', difficulty: 'easy', sessionType: 'fixed',
      questionCount: 2, answerMode: 'mcq', mcqOptionCount: 4, now: c.now
    });
    s.start();
    var q = s.currentQuestion();
    a.equal(q.options.length, 4);
    a.equal(q.options.filter(function (o) { return o.correct; }).length, 1);
    var res = s.submit(q.correctOptionIndex);
    a.equal(res.ok, true);
    a.equal(res.status, 'correct');
    a.equal(s.getRecords()[0].status, 'correct');
    var badRes = s.submit(0);
    a.equal(badRes.ok, false, 'cannot submit twice');
  });

  t('an endless session keeps producing questions until stopped', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'squares', difficulty: 'medium', sessionType: 'endless', now: c.now });
    s.start();
    for (var i = 0; i < 40; i++) {
      a.ok(s.currentQuestion() !== null);
      s.skip();
      var n = s.next();
      a.equal(n.done, false, 'endless mode never auto-completes');
    }
    a.equal(s.getState(), D().STATES.RUNNING);
    a.equal(s.getRecords().length, 40, 'forty skipped questions are recorded');
    s.end();
    a.equal(s.getState(), D().STATES.COMPLETED);
    // the question that was on screen when End was pressed is reported too
    a.equal(s.getRecords().length, 41);
  });

  t('ending a drill manually yields a valid report', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'endless', now: c.now });
    s.start();
    s.submit(G().answerText(s.currentQuestion().answer));
    s.next();
    c.advance(3000);
    s.end();
    var r = s.getResults();
    a.equal(s.getState(), D().STATES.COMPLETED);
    a.equal(r.presented, 2, 'the abandoned second question is still reported');
    a.equal(r.correct, 1);
    a.equal(r.skipped, 1);
    a.ok(!/NaN|Infinity/.test(JSON.stringify(r)));
  });

  t('retry-wrong-questions re-presents the same questions as new attempts', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 3, now: c.now });
    s.start();
    // a numeric-but-wrong answer is scored incorrect; malformed text would be
    // rejected as "invalid" and left unanswered (spec §6)
    s.submit('999999999');
    s.next(); s.currentQuestion(); s.skip();
    s.next(); s.currentQuestion(); s.submit(G().answerText(s.currentQuestion().answer));
    s.next();
    var records = s.getRecords();
    a.equal(records.filter(function (r) { return r.status === 'incorrect' || r.status === 'skipped'; }).length, 2);

    var retry = D().createRetrySession(records, s.getConfig());
    a.ok(retry !== null, 'a retry session should be created from mistakes');
    retry.start();
    a.equal(retry.currentQuestion().prompt, records[0].prompt, 'the original question is re-presented');
    a.equal(retry.getConfig().questionCount, 2, 'one question per mistake');
    a.equal(retry.getRecords().length, 0, 'the original results are untouched');
    retry.submit(G().answerText(retry.currentQuestion().answer));
    a.equal(retry.getRecords()[0].status, 'correct');
    a.equal(retry.getRecords()[0].isRetry, true);
  });

  t('a drill with nothing to retry returns no retry session', function (a) {
    a.equal(D().createRetrySession([{ index: 1, status: 'correct' }], {}), null);
    a.equal(D().createRetrySession([], {}), null);
  });

  t('config validation blocks impossible setups and allows endless', function (a) {
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'fixed', questionCount: 0 }).valid, false);
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'fixed', questionCount: 501 }).valid, false);
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'fixed', questionCount: 10 }).valid, true);
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'countdown', durationMs: 5000 }).valid, false, 'too short');
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'countdown', durationMs: 60000 }).valid, true);
    a.equal(D().validateConfig({ topic: 'addition', sessionType: 'endless' }).valid, true, 'endless needs no count');
    a.equal(D().validateConfig({ topic: 'mixed', topics: [] }).valid, false, 'mixed needs topics');
    a.equal(D().validateConfig({ topic: 'mixed', topics: [{ id: 'addition', weight: 0 }] }).valid, false, 'weights must be positive');
    a.equal(D().validateConfig({ topic: 'mixed', topics: [{ id: 'addition', weight: 5 }] }).valid, true);
    a.equal(D().validateConfig({ topic: 'nope' }).valid, false);
  });

  t('mixed practice draws from the selected topics and normalises weights', function (a) {
    var c = fakeClock();
    var s = D().createSession({
      topic: 'mixed',
      topics: [{ id: 'addition', weight: 50 }, { id: 'squares', weight: 50 }],
      difficulty: 'easy', sessionType: 'fixed', questionCount: 40, now: c.now
    });
    var cfg = s.getConfig();
    a.ok(Math.abs(cfg.topics[0].weight - 0.5) < 1e-9, 'weights normalise to 0.5/0.5');
    s.start();
    var seen = {};
    for (var i = 0; i < 40; i++) { seen[s.currentQuestion().topic] = true; s.skip(); s.next(); }
    a.ok(seen.addition, 'mixed practice used addition');
    a.ok(seen.squares, 'mixed practice used squares');
    var r = s.getResults();
    a.equal(r.topicWise.length, 2, 'both topics appear in the topic-wise report');
  });

  t('adaptive difficulty rises after five strong answers and can be disabled', function (a) {
    var c = fakeClock();
    var s = D().createSession({
      topic: 'addition', difficulty: 'easy', sessionType: 'endless', adaptive: true, now: c.now
    });
    s.start();
    for (var i = 0; i < 5; i++) {
      s.submit(G().answerText(s.currentQuestion().answer));
      c.advance(800);
      s.next();
    }
    a.equal(s.getCurrentDifficulty(), 'medium', 'five fast correct answers raise the level');

    var c2 = fakeClock();
    var fixed = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'endless', adaptive: false, now: c2.now });
    fixed.start();
    for (var j = 0; j < 8; j++) { fixed.submit(G().answerText(fixed.currentQuestion().answer)); c2.advance(500); fixed.next(); }
    a.equal(fixed.getCurrentDifficulty(), 'easy', 'a fixed drill never changes level');
  });

  t('the same drill produces fresh questions on a second run', function (a) {
    var c1 = fakeClock(), c2 = fakeClock();
    function run(clock) {
      var s = D().createSession({ topic: 'multiplication', difficulty: 'medium', sessionType: 'fixed', questionCount: 12, now: clock.now });
      s.start();
      var prompts = [];
      for (var i = 0; i < 12; i++) { prompts.push(s.currentQuestion().prompt); s.skip(); s.next(); }
      return prompts;
    }
    var a1 = run(c1), a2 = run(c2);
    a.ok(a1.join('|') !== a2.join('|'), 'a repeated drill should not be identical');
  });

  t('a session cannot be restarted after completion without a new instance', function (a) {
    var c = fakeClock();
    var s = D().createSession({ topic: 'addition', difficulty: 'easy', sessionType: 'fixed', questionCount: 1, now: c.now });
    s.start();
    s.submit(G().answerText(s.currentQuestion().answer));
    s.next();
    a.equal(s.getState(), D().STATES.COMPLETED);
    a.equal(s.start(), false, 'start on a completed session is a no-op');
    a.equal(s.getRecords().length, 1);
  });

  return cases;
});
