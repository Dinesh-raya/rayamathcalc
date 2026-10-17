/* =============================================================================
 * validation.js — answer parsing, normalisation and checking.
 *
 * Pure functions only: no DOM, no timers, no side effects.
 * Loads as a classic <script> in the browser and as a CommonJS module under
 * Node (so the pure engine can be unit-tested with `node --test`).
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.validation = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- helpers */

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a || 0;
  }

  function lcm(a, b) {
    if (!a || !b) return 0;
    return Math.abs(a * b) / gcd(a, b);
  }

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /** Round to `places` decimal places, avoiding 0.30000000000000004 noise. */
  function roundTo(value, places) {
    var p = places == null ? 2 : places;
    var f = Math.pow(10, p);
    return Math.round((value + (value < 0 ? -1 : 1) * Number.EPSILON) * f) / f;
  }

  /** Human-friendly number text (no digit grouping; keeps arithmetic readable). */
  function formatNumber(value, places) {
    if (value == null || !isFinite(value)) return '—';
    if (places == null) {
      // present integers cleanly, otherwise trim to 6 dp and strip trailing zeros
      if (isInt(value)) return String(value);
      return String(roundTo(value, 6)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
    return value.toFixed(places);
  }

  /* --------------------------------------------------------------- parsers */
  /* Each parser returns a normalised value or null when the text is not a
   * recognisable form of that answer type. null means "invalid input", which
   * callers must treat as "not submitted" rather than "wrong" (spec §6). */

  function parseNumber(text) {
    if (text == null) return null;
    var s = String(text).trim();
    if (!s) return null;
    s = s.replace(/[\s,]/g, '').replace(/[\u2212\u2013\u2014]/g, '-');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function parsePercentage(text) {
    if (text == null) return null;
    var raw = String(text).trim();
    if (!raw) return null;
    var hadSign = /%/.test(raw);
    var s = raw.replace(/%/g, '').trim();
    var n = parseNumber(s);
    if (n == null) return null;
    return { value: n, explicitPercent: hadSign };
  }

  function parseFraction(text) {
    if (text == null) return null;
    var raw = String(text).trim();
    if (!raw) return null;

    var m = raw.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
    if (m) {
      var num = parseInt(m[1], 10);
      var den = parseInt(m[2], 10);
      if (den === 0) return null;
      return { num: num, den: den };
    }

    var mixed = raw.match(/^([+-]?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (mixed) {
      var whole = parseInt(mixed[1], 10);
      var n2 = parseInt(mixed[2], 10);
      var d2 = parseInt(mixed[3], 10);
      if (d2 === 0) return null;
      var sign = whole < 0 ? -1 : 1;
      return { num: sign * (Math.abs(whole) * d2 + n2), den: d2 };
    }

    return null;
  }

  /** "17 R 3", "17 r3", "17 remainder 3", "17,3" — quotient with remainder. */
  function parseDivisionAnswer(text) {
    if (text == null) return null;
    var raw = String(text).trim();
    if (!raw) return null;

    var m = raw.match(/^([+-]?\d+)\s*(?:r|R|rem|remainder|\+|\/|,|\s)\s*([+-]?\d+)$/);
    if (m) {
      return { quotient: parseInt(m[1], 10), remainder: parseInt(m[2], 10) };
    }
    var q = parseNumber(raw);
    if (q != null && isInt(q)) return { quotient: q, remainder: 0 };
    return null;
  }

  function simplifyFraction(num, den) {
    if (den < 0) { num = -num; den = -den; }
    var g = gcd(num, den) || 1;
    return { num: Math.round(num / g), den: Math.round(den / g) };
  }

  /* ---------------------------------------------------------------- checks */

  /**
   * Compare a user answer against a question's canonical answer.
   * @param {string|number} userInput
   * @param {object} question  a generated question (see generators.js schema)
   * @returns {{status:'correct'|'incorrect'|'invalid', reason?:string}}
   */
  function check(userInput, question) {
    if (!question || !question.answer) return { status: 'invalid', reason: 'No answer to compare against.' };
    var answer = question.answer;

    if (userInput == null || String(userInput).trim() === '') {
      return { status: 'invalid', reason: 'Enter an answer first.' };
    }

    switch (answer.type) {
      case 'integer': {
        var n = parseNumber(userInput);
        if (n == null) return { status: 'invalid', reason: 'Enter a whole number.' };
        return Math.abs(n - answer.value) < 1e-9
          ? { status: 'correct' }
          : { status: 'incorrect' };
      }

      case 'decimal': {
        var d = parseNumber(userInput);
        if (d == null) return { status: 'invalid', reason: 'Enter a number (decimals allowed).' };
        var places = answer.places == null ? 2 : answer.places;
        var tol = Math.pow(10, -places) / 2 + 1e-9;
        return Math.abs(d - answer.value) <= tol
          ? { status: 'correct' }
          : { status: 'incorrect' };
      }

      case 'percentage': {
        var p = parsePercentage(userInput);
        if (p == null) return { status: 'invalid', reason: 'Enter a percentage, e.g. 12.5 or 12.5%.' };
        var pp = answer.places == null ? 2 : answer.places;
        var ptol = Math.pow(10, -pp) / 2 + 1e-9;
        return Math.abs(p.value - answer.value) <= ptol
          ? { status: 'correct' }
          : { status: 'incorrect' };
      }

      case 'fraction': {
        var f = parseFraction(userInput);
        if (f == null) {
          // a whole-number answer is valid (e.g. 1/2 ÷ 1/2 = 1)
          var asInt = parseNumber(userInput);
          if (asInt != null && Math.floor(asInt) === asInt) { f = { num: asInt, den: 1 }; }
        }
        if (f == null) return { status: 'invalid', reason: 'Enter a fraction, e.g. 3/4.' };
        var correct = (f.num * answer.den) === (answer.num * f.den);
        if (!correct) return { status: 'incorrect' };
        if (answer.requireSimplified) {
          var s = simplifyFraction(f.num, f.den);
          if (s.num !== f.num || s.den !== f.den || f.den < 0) {
            return { status: 'incorrect', reason: 'Correct value, but not in lowest terms.' };
          }
        }
        return { status: 'correct' };
      }

      case 'division': {
        var dr = parseDivisionAnswer(userInput);
        if (dr == null) {
          return {
            status: 'invalid',
            reason: answer.remainder
              ? 'Enter quotient and remainder, e.g. "17 R 3".'
              : 'Enter a whole number.'
          };
        }
        if (answer.remainder === 0) {
          // remainder is zero, so a plain quotient is the complete answer
          return dr.quotient === answer.quotient && dr.remainder === 0
            ? { status: 'correct' }
            : { status: 'incorrect' };
        }
        return (dr.quotient === answer.quotient && dr.remainder === answer.remainder)
          ? { status: 'correct' }
          : { status: 'incorrect' };
      }

      default:
        return { status: 'invalid', reason: 'Unsupported answer type.' };
    }
  }

  /** Canonical display text for a correct answer (used in the review screen). */
  function answerToText(answer) {
    if (!answer) return '—';
    switch (answer.type) {
      case 'integer':     return formatNumber(answer.value);
      case 'decimal':     return formatNumber(answer.value, answer.places == null ? 2 : answer.places);
      case 'percentage':  return formatNumber(answer.value, answer.places == null ? 2 : answer.places).replace(/\.?0+$/, '') + '%';
      case 'fraction':    return answer.den === 1 ? String(answer.num) : answer.num + '/' + answer.den;
      case 'division':    return answer.remainder
                            ? answer.quotient + ' R ' + answer.remainder
                            : String(answer.quotient);
      default:            return '—';
    }
  }

  return {
    gcd: gcd,
    lcm: lcm,
    isInt: isInt,
    roundTo: roundTo,
    formatNumber: formatNumber,
    parseNumber: parseNumber,
    parsePercentage: parsePercentage,
    parseFraction: parseFraction,
    parseDivisionAnswer: parseDivisionAnswer,
    simplifyFraction: simplifyFraction,
    check: check,
    answerToText: answerToText
  };
});
