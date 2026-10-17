/* =============================================================================
 * analytics.js — scoring, statistics and review data.
 *
 * Pure: takes the session's question records and returns numbers. Never touches
 * the DOM and never guesses: any statistic that has no data behind it is
 * returned as null so the UI can say "not enough data" instead of NaN/Infinity
 * (spec §9, §19, §20-B).
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.analytics = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Division that yields null rather than Infinity/NaN when the bottom is 0. */
  function safeDiv(numerator, denominator) {
    if (!denominator || !isFinite(denominator)) return null;
    var v = numerator / denominator;
    return isFinite(v) ? v : null;
  }

  function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

  var STATUSES = ['correct', 'incorrect', 'skipped', 'timedout'];

  /**
   * @param {Array} records  question records produced by drills.js
   * @param {object} [opts]
   * @param {number} [opts.sessionMs]        total wall-clock time of the drill
   * @param {boolean} [opts.negativeMarking]
   * @param {number} [opts.negativeFraction=0.25]
   * @param {number} [opts.slowMultiplier=1.5] response times above this multiple
   *        of the average are flagged "slow" in the review filters
   * @param {number} [opts.slowCount=5]      how many slowest questions to list
   */
  function computeResults(records, opts) {
    opts = opts || {};
    records = Array.isArray(records) ? records : [];

    var counts = { correct: 0, incorrect: 0, skipped: 0, timedout: 0 };
    var answeredMsTotal = 0;
    var answered = 0;

    records.forEach(function (r) {
      var st = r && r.status;
      if (counts.hasOwnProperty(st)) counts[st]++;
      if (st === 'correct' || st === 'incorrect') {
        answered++;
        answeredMsTotal += (isFinite(r.responseMs) && r.responseMs > 0) ? r.responseMs : 0;
      }
    });

    var presented = records.length;
    var unanswered = presented - answered - counts.skipped - counts.timedout;

    var accuracy = safeDiv(counts.correct * 100, answered);
    var correctOfPresented = safeDiv(counts.correct * 100, presented);
    var avgResponseMs = safeDiv(answeredMsTotal, answered);

    var sessionMs = isFinite(opts.sessionMs) && opts.sessionMs > 0 ? opts.sessionMs : 0;
    var minutes = sessionMs / 60000;
    var attemptsPerMin = minutes > 0 ? safeDiv(answered, minutes) : null;
    var correctPerMin = minutes > 0 ? safeDiv(counts.correct, minutes) : null;

    var negFraction = isFinite(opts.negativeFraction) ? opts.negativeFraction : 0.25;
    var score = counts.correct - (opts.negativeMarking ? counts.incorrect * negFraction : 0);

    var slowMultiplier = isFinite(opts.slowMultiplier) ? opts.slowMultiplier : 1.5;
    var slowThresholdMs = avgResponseMs == null ? null : avgResponseMs * slowMultiplier;

    return {
      presented: presented,
      answered: answered,
      correct: counts.correct,
      incorrect: counts.incorrect,
      skipped: counts.skipped,
      timedOut: counts.timedout,
      unanswered: unanswered < 0 ? 0 : unanswered,

      accuracy: round2(accuracy),                       // correct / answered × 100
      correctOfPresented: round2(correctOfPresented),   // correct / presented × 100

      avgResponseMs: avgResponseMs == null ? null : Math.round(avgResponseMs),
      totalMs: sessionMs,
      attemptsPerMin: round2(attemptsPerMin),
      correctPerMin: round2(correctPerMin),

      negativeMarking: !!opts.negativeMarking,
      negativeFraction: negFraction,
      score: score,

      slowThresholdMs: slowThresholdMs == null ? null : Math.round(slowThresholdMs),
      topicWise: topicWise(records),
      slowest: slowest(records, isFinite(opts.slowCount) ? opts.slowCount : 5),
      errorTopics: errorTopics(records),

      hasData: presented > 0,
      hasAnswered: answered > 0
    };
  }

  function topicWise(records) {
    var map = {};
    records.forEach(function (r) {
      var t = (r && r.topic) || 'unknown';
      if (!map[t]) {
        map[t] = { topic: t, presented: 0, answered: 0, correct: 0, incorrect: 0,
                   skipped: 0, timedout: 0, msTotal: 0 };
      }
      var g = map[t];
      g.presented++;
      if (r.status === 'correct' || r.status === 'incorrect') {
        g.answered++;
        g.msTotal += (isFinite(r.responseMs) && r.responseMs > 0) ? r.responseMs : 0;
      }
      if (r.status === 'correct') g.correct++;
      else if (r.status === 'incorrect') g.incorrect++;
      else if (r.status === 'skipped') g.skipped++;
      else if (r.status === 'timedout') g.timedout++;
    });
    return Object.keys(map).map(function (k) {
      var g = map[k];
      return {
        topic: g.topic,
        presented: g.presented,
        answered: g.answered,
        correct: g.correct,
        incorrect: g.incorrect,
        skipped: g.skipped,
        timedOut: g.timedout,
        accuracy: round2(safeDiv(g.correct * 100, g.answered)),
        avgResponseMs: g.answered ? Math.round(g.msTotal / g.answered) : null
      };
    }).sort(function (a, b) { return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0; });
  }

  function slowest(records, count) {
    return records
      .filter(function (r) { return r && isFinite(r.responseMs) && r.responseMs > 0; })
      .slice()
      .sort(function (a, b) { return b.responseMs - a.responseMs; })
      .slice(0, count)
      .map(function (r) { return { index: r.index, prompt: r.prompt, topic: r.topic, responseMs: r.responseMs }; });
  }

  function errorTopics(records) {
    var map = {};
    records.forEach(function (r) {
      var t = (r && r.topic) || 'unknown';
      if (r.status === 'incorrect' || r.status === 'skipped' || r.status === 'timedout') {
        map[t] = (map[t] || 0) + 1;
      }
    });
    return Object.keys(map)
      .map(function (k) { return { topic: k, errors: map[k] }; })
      .sort(function (a, b) { return b.errors - a.errors; });
  }

  /**
   * Review filters (spec §19). Returns a new array; never mutates the input.
   * @param {string} filter  all | incorrect | skipped | timedout | slow
   */
  function filterRecords(records, filter, slowThresholdMs) {
    if (!Array.isArray(records)) return [];
    switch (filter) {
      case 'incorrect': return records.filter(function (r) { return r.status === 'incorrect'; });
      case 'skipped':   return records.filter(function (r) { return r.status === 'skipped'; });
      case 'timedout':  return records.filter(function (r) { return r.status === 'timedout'; });
      case 'slow':      return records.filter(function (r) {
                          return isFinite(slowThresholdMs) && isFinite(r.responseMs) &&
                                 r.responseMs >= slowThresholdMs && r.status !== null;
                        });
      default:          return records.slice();
    }
  }

  /** Records that should be re-drilled: wrong, skipped or timed out. */
  function mistakeRecords(records) {
    if (!Array.isArray(records)) return [];
    return records.filter(function (r) {
      return r && (r.status === 'incorrect' || r.status === 'skipped' || r.status === 'timedout');
    });
  }

  return {
    safeDiv: safeDiv,
    round2: round2,
    computeResults: computeResults,
    topicWise: topicWise,
    slowest: slowest,
    errorTopics: errorTopics,
    filterRecords: filterRecords,
    mistakeRecords: mistakeRecords
  };
});
