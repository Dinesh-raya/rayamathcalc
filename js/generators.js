/* =============================================================================
 * generators.js — rule-based question generation for every topic.
 *
 * Design rules (spec §5, §19):
 *   • Every topic has several *patterns*, not just randomised operands.
 *   • Difficulty changes the pattern set and complexity, not merely magnitude.
 *   • The correct answer is computed from the same numbers/expression that is
 *     rendered, never re-parsed from the prompt, never taken from user input.
 *   • Every arithmetic operation is validated before the question is returned;
 *     construction is retried a bounded number of times and always falls back
 *     to a known-good expression.
 *   • Explanations are produced from the same construction/pattern, so an
 *     explanation can never describe a different question.
 *
 * Pure: no DOM. Usable as a classic script and as a Node module.
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.generators = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_ATTEMPTS = 60;

  /* ------------------------------------------------------------- utilities */

  function R(min, max) {                      // inclusive integer range
    if (max < min) { var t = min; min = max; max = t; }
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function weightedPick(pairs) {              // [[item, weight], ...]
    var total = 0, i;
    for (i = 0; i < pairs.length; i++) total += pairs[i][1];
    if (total <= 0) return pairs[0][0];
    var r = Math.random() * total;
    for (i = 0; i < pairs.length; i++) {
      r -= pairs[i][1];
      if (r <= 0) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 0; }
  function lcm(a, b) { if (!a || !b) return 0; return Math.abs(a * b) / gcd(a, b); }
  function simplify(n, d) { if (d < 0) { n = -n; d = -d; } var g = gcd(n, d) || 1; return { num: n / g, den: d / g }; }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function pow10(d) { return Math.pow(10, d); }
  function rangeForDigits(d) { return [d <= 1 ? 2 : pow10(d - 1), pow10(d) - 1]; }
  function numWithDigits(d) { var r = rangeForDigits(d); return R(r[0], r[1]); }
  function roundTo(v, p) { var f = pow10(p); return Math.round((v + (v < 0 ? -1 : 1) * Number.EPSILON) * f) / f; }
  function decimalsOf(v) {
    if (isInt(v)) return 0;
    var s = String(roundTo(v, 6)).split('.')[1];
    return s ? s.replace(/0+$/, '').length : 0;
  }

  /* --------------------------------------------------------- shared tables */

  // Common bank-exam fraction ↔ percentage relationships (spec §5).
  var FRACTION_PERCENT = [
    { f: [1, 2], p: 50 },    { f: [1, 3], p: 33.33 }, { f: [2, 3], p: 66.67 },
    { f: [1, 4], p: 25 },    { f: [3, 4], p: 75 },    { f: [1, 5], p: 20 },
    { f: [2, 5], p: 40 },    { f: [3, 5], p: 60 },    { f: [4, 5], p: 80 },
    { f: [1, 6], p: 16.67 }, { f: [1, 7], p: 14.29 }, { f: [1, 8], p: 12.5 },
    { f: [3, 8], p: 37.5 },  { f: [5, 8], p: 62.5 },  { f: [7, 8], p: 87.5 },
    { f: [1, 9], p: 11.11 }, { f: [2, 9], p: 22.22 }, { f: [1, 10], p: 10 },
    { f: [1, 11], p: 9.09 }, { f: [1, 12], p: 8.33 }, { f: [1, 16], p: 6.25 },
    { f: [1, 20], p: 5 },    { f: [3, 20], p: 15 },   { f: [1, 25], p: 4 },
    { f: [1, 40], p: 2.5 }
  ];

  var PCT_FRIENDLY = [5, 10, 12.5, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 110, 120, 125, 150, 200, 250];

  function pctEquivalent(p) {
    var target = null, best = 1e9;
    for (var i = 0; i < FRACTION_PERCENT.length; i++) {
      var d = Math.abs(FRACTION_PERCENT[i].p - p);
      if (d < best) { best = d; target = FRACTION_PERCENT[i]; }
    }
    return best < 0.02 ? target : null;
  }

  /* --------------------------------------------------------- answer makers */

  var A = {
    integer:  function (v) { return { type: 'integer', value: Math.round(v) }; },
    decimal:  function (v, places) { return { type: 'decimal', value: roundTo(v, places), places: places }; },
    percentage: function (v, places) {
      var p = places == null ? (decimalsOf(v) || 2) : places;
      return { type: 'percentage', value: roundTo(v, p), places: p };
    },
    fraction: function (n, d, requireSimplified) {
      var s = simplify(n, d);
      return { type: 'fraction', num: s.num, den: s.den, requireSimplified: !!requireSimplified };
    },
    division: function (q, r) { return { type: 'division', quotient: q, remainder: r || 0 }; }
  };

  function Q(topic, pattern, difficulty, prompt, answer, explanation, meta) {
    return {
      topic: topic,
      subtopic: pattern,
      pattern: pattern,
      difficulty: difficulty,
      prompt: prompt,
      answer: answer,
      answerType: answer.type,
      explanation: explanation || null,
      meta: meta || {}
    };
  }

  /* ================================================================= TOPICS */

  var TOPICS = {};
  function topic(def) { TOPICS[def.id] = def; }

  /* ------------------------------------------------------------ 1. adding */

  topic({
    id: 'addition', label: 'Addition', group: 'Basic operations',
    settings: [
      { key: 'terms', label: 'Number of terms', type: 'int', min: 2, max: 6, step: 1, def: 3,
        help: 'How many numbers are added together.' },
      { key: 'digitMax', label: 'Largest number (digits)', type: 'int', min: 1, max: 5, step: 1, def: 3,
        help: 'Operands are chosen up to this many digits.' }
    ],
    presets: { easy: { terms: 2, digitMax: 2 }, medium: { terms: 3, digitMax: 3 }, hard: { terms: 5, digitMax: 4 } },
    generate: function (s, diff) {
      var terms = Math.max(2, Math.min(6, s.terms | 0));
      var digits = Math.max(1, Math.min(5, s.digitMax | 0));
      var lo = digits <= 1 ? 2 : pow10(digits - 1);
      var hi = pow10(digits) - 1;

      var pattern = weightedPick([
        ['plain', 50],
        ['near-round', digits >= 3 ? 30 : 0],
        ['complement', digits >= 3 ? 20 : 0]
      ]);

      if (pattern === 'complement' && terms >= 2) {
        // Build pairs that sum to a round total (e.g. 475 + 525), a classic shortcut.
        var target = pow10(digits);
        var values = [], used = 0, pairs = Math.floor(terms / 2);
        for (var p = 0; p < pairs; p++) {
          var a = R(Math.floor(target * 0.35), Math.floor(target * 0.65));
          var b = target - a;
          if (b >= lo && b <= hi && a >= lo) { values.push(a, b); used += 2; }
        }
        if (used >= 2) {
          var total = 0; for (var i = 0; i < values.length; i++) total += values[i];
          return Q('addition', 'complement', diff,
            values.join(' + '), A.integer(total),
            'Complement pairs add to a round number (' + target + '), so ' +
            values.join(' + ') + ' = ' + total + '.',
            { operands: values, pattern: 'complement' });
        }
      }

      if (pattern === 'near-round') {
        var vals = [], anchor = pow10(digits);
        for (var k = 0; k < terms; k++) {
          var base = anchor - R(1, Math.max(2, Math.round(anchor * 0.02)));
          vals.push(k % 2 === 0 ? base : base + R(1, 9));
        }
        var sum = 0; for (var m = 0; m < vals.length; m++) sum += vals[m];
        return Q('addition', 'near-round', diff,
          vals.join(' + '), A.integer(sum),
          'Round each number to ' + anchor + ', add the round values, then add back the small deficits: ' +
          vals.map(function (v) { return v + ' \u2248 ' + anchor; }).join(', ') + ', giving ' + sum + '.',
          { operands: vals });
      }

      var nums = [];
      for (var n = 0; n < terms; n++) nums.push(R(lo, hi));
      var t2 = 0; for (var q = 0; q < nums.length; q++) t2 += nums[q];
      return Q('addition', 'plain', diff, nums.join(' + '), A.integer(t2),
        'Add left to right in groups that reach round numbers: ' + nums.join(' + ') + ' = ' + t2 + '.',
        { operands: nums });
    }
  });

  /* --------------------------------------------------------- 2. subtracting */

  topic({
    id: 'subtraction', label: 'Subtraction', group: 'Basic operations',
    settings: [
      { key: 'digitMax', label: 'Largest number (digits)', type: 'int', min: 1, max: 5, step: 1, def: 3 },
      { key: 'allowNegative', label: 'Allow negative answers', type: 'checkbox', def: false }
    ],
    presets: { easy: { digitMax: 2, allowNegative: false }, medium: { digitMax: 3, allowNegative: false }, hard: { digitMax: 4, allowNegative: false } },
    generate: function (s, diff) {
      var digits = Math.max(1, Math.min(5, s.digitMax | 0));
      var lo = digits <= 1 ? 2 : pow10(digits - 1);
      var hi = pow10(digits) - 1;
      var pattern = weightedPick([['plain', 60], ['near-round', digits >= 3 ? 40 : 0]]);

      if (pattern === 'near-round') {
        var anchor = pow10(digits);
        var big = R(Math.floor(anchor * 0.6), anchor - 1);
        var sub = anchor - R(1, 9);            // e.g. subtract 998
        var res = big - sub;
        if (!s.allowNegative && res < 0) { var tmp = big; big = sub; sub = tmp; res = big - sub; }
        return Q('subtraction', 'near-round', diff, big + ' \u2212 ' + sub, A.integer(res),
          'Subtract the round number and add back the difference: ' + big + ' \u2212 ' + anchor +
          ' = ' + (big - anchor) + ', then add ' + (anchor - sub) + ' \u2192 ' + res + '.',
          { a: big, b: sub });
      }

      var a = R(lo, hi), b = R(lo, hi);
      if (!s.allowNegative && b > a) { var t = a; a = b; b = t; }
      return Q('subtraction', 'plain', diff, a + ' \u2212 ' + b, A.integer(a - b),
        'Subtract in place value blocks (hundreds, tens, units) and borrow where needed: ' +
        a + ' \u2212 ' + b + ' = ' + (a - b) + '.',
        { a: a, b: b });
    }
  });

  /* ------------------------------------------------------- 3. multiplication */

  topic({
    id: 'multiplication', label: 'Multiplication', group: 'Basic operations',
    settings: [
      { key: 'digitA', label: 'First number (digits)', type: 'int', min: 1, max: 4, step: 1, def: 2 },
      { key: 'digitB', label: 'Second number (digits)', type: 'int', min: 1, max: 4, step: 1, def: 2 }
    ],
    presets: { easy: { digitA: 2, digitB: 1 }, medium: { digitA: 2, digitB: 2 }, hard: { digitA: 3, digitB: 2 } },
    generate: function (s, diff) {
      var da = Math.max(1, Math.min(4, s.digitA | 0));
      var db = Math.max(1, Math.min(4, s.digitB | 0));

      var pattern = weightedPick([
        ['single-digit', (da + db) === 2 ? 100 : 0],
        ['times-11', 12],
        ['times-5-25-50-125', 18],
        ['near-100', (da >= 2 && db >= 2) ? 25 : 0],
        ['times-99-999', (da >= 2 && db >= 2) ? 15 : 0],
        ['general', 45]
      ]);

      if (pattern === 'times-11') {
        var n = numWithDigits(Math.max(1, Math.max(da, db) <= 3 ? 3 : Math.max(da, db)));
        return Q('multiplication', 'times-11', diff, n + ' × 11', A.integer(n * 11),
          'Multiplication by 11: write the first digit, then add adjacent digits from the right, then the last digit. ' +
          n + ' × 11 = ' + (n * 11) + '.', { a: n, b: 11 });
      }

      if (pattern === 'times-5-25-50-125') {
        var f = pick([5, 25, 50, 125]);
        var other = R(2, Math.max(4, pow10(Math.max(da, db)) - 1));
        var map = {
          5: ['\u00d710 then \u00f72', 10, 2],
          25: ['\u00d7100 then \u00f74', 100, 4],
          50: ['\u00d7100 then \u00f72', 100, 2],
          125: ['\u00d71000 then \u00f78', 1000, 8]
        };
        var info = map[f];
        return Q('multiplication', 'times-5-25-50-125', diff, f + ' × ' + other, A.integer(f * other),
          'Shortcut for \u00d7' + f + ': ' + info[0] + '. ' + other + ' \u00d7 ' + info[1] + ' = ' +
          (other * info[1]) + ', divided by ' + info[2] + ' = ' + (f * other) + '.',
          { a: f, b: other });
      }

      if (pattern === 'near-100') {
        var below = Math.random() < 0.6;
        var x = R(1, 15), y = R(1, 15);
        var a, b;
        if (below) { a = 100 - x; b = 100 - y; }
        else { a = 100 + x; b = 100 + y; }
        var val = a * b;
        var expl;
        if (below) {
          expl = '(100 \u2212 ' + x + ')(100 \u2212 ' + y + ') = 100(100 \u2212 ' + x + ' \u2212 ' + y +
                 ') + ' + (x * y) + ' = ' + (100 * (100 - x - y)) + ' + ' + (x * y) + ' = ' + val + '.';
        } else {
          expl = '(100 + ' + x + ')(100 + ' + y + ') = 100(100 + ' + x + ' + ' + y + ') + ' + (x * y) +
                 ' = ' + (100 * (100 + x + y)) + ' + ' + (x * y) + ' = ' + val + '.';
        }
        return Q('multiplication', 'near-100', diff, a + ' × ' + b, A.integer(val),
          'Base-100 method: ' + expl, { a: a, b: b, x: x, y: y });
      }

      if (pattern === 'times-99-999') {
        var r = pick([99, 999, 98, 997]);
        var n2 = R(3, Math.max(12, pow10(Math.max(da, db)) - 1));
        var p2 = pow10(String(r).length) - r; // small deficit
        return Q('multiplication', 'times-99-999', diff, n2 + ' × ' + r, A.integer(n2 * r),
          'Treat ' + r + ' as ' + pow10(String(r).length) + ' \u2212 ' + p2 + ': ' + n2 + ' \u00d7 ' +
          pow10(String(r).length) + ' = ' + (n2 * pow10(String(r).length)) + ', minus ' + n2 + ' \u00d7 ' +
          p2 + ' = ' + (n2 * p2) + ', giving ' + (n2 * r) + '.', { a: n2, b: r });
      }

      var lo1 = da <= 1 ? 2 : pow10(da - 1), hi1 = pow10(da) - 1;
      var lo2 = db <= 1 ? 2 : pow10(db - 1), hi2 = pow10(db) - 1;
      var pa = R(lo1, hi1), pb = R(lo2, hi2);
      if (da + db === 2) { pa = R(2, 12); pb = R(2, 12); }
      return Q('multiplication', 'general', diff, pa + ' × ' + pb, A.integer(pa * pb),
        'Split the larger number by place value and multiply each part, then add: e.g. ' + pa + ' \u00d7 ' +
        pb + ' = ' + pa + ' \u00d7 (' + (Math.floor(pb / 10) * 10) + ' + ' + (pb % 10) + ') = ' +
        (pa * Math.floor(pb / 10) * 10) + ' + ' + (pa * (pb % 10)) + ' = ' + (pa * pb) + '.',
        { a: pa, b: pb });
    }
  });

  /* ----------------------------------------------------------- 4. division */

  topic({
    id: 'division', label: 'Division', group: 'Basic operations',
    settings: [
      { key: 'mode', label: 'Result', type: 'select', def: 'exact',
        options: [{ value: 'exact', label: 'Exact division only' }, { value: 'remainder', label: 'Allow remainders' }] },
      { key: 'digitDivisor', label: 'Divisor (digits)', type: 'int', min: 1, max: 3, step: 1, def: 1 },
      { key: 'digitQuotient', label: 'Quotient (digits)', type: 'int', min: 1, max: 4, step: 1, def: 2 }
    ],
    presets: { easy: { mode: 'exact', digitDivisor: 1, digitQuotient: 2 }, medium: { mode: 'exact', digitDivisor: 1, digitQuotient: 3 }, hard: { mode: 'remainder', digitDivisor: 2, digitQuotient: 3 } },
    generate: function (s, diff) {
      // divisor and quotient are generated first so the dividend is always valid (§5)
      var dDiv = Math.max(1, Math.min(3, s.digitDivisor | 0));
      var dQuo = Math.max(1, Math.min(4, s.digitQuotient | 0));
      var divisor = dDiv <= 1 ? R(2, 9) : numWithDigits(dDiv);
      if (divisor <= 0) divisor = R(2, 9);
      var quotient = dQuo <= 1 ? R(2, 9) : numWithDigits(dQuo);
      var remainder = 0;
      if (s.mode === 'remainder') remainder = R(1, divisor - 1);
      var dividend = divisor * quotient + remainder;

      var expl = 'Because ' + divisor + ' \u00d7 ' + quotient + ' = ' + (divisor * quotient) +
        (remainder ? ' and adding the remainder ' + remainder + ' gives ' + dividend + '.' : ', the quotient is ' + quotient + '.');

      return Q('division', s.mode === 'remainder' ? 'with-remainder' : 'exact', diff,
        dividend + ' ÷ ' + divisor, A.division(quotient, remainder), expl,
        { dividend: dividend, divisor: divisor, quotient: quotient, remainder: remainder });
    }
  });

  /* -------------------------------------------------- 5. multiplication tables */

  topic({
    id: 'tables', label: 'Multiplication tables', group: 'Basic operations',
    settings: [
      { key: 'tableMin', label: 'Table from', type: 'int', min: 2, max: 30, step: 1, def: 2 },
      { key: 'tableMax', label: 'Table to', type: 'int', min: 2, max: 30, step: 1, def: 12 },
      { key: 'multMax', label: 'Multiply up to', type: 'int', min: 5, max: 50, step: 1, def: 10 }
    ],
    presets: { easy: { tableMin: 2, tableMax: 12, multMax: 10 }, medium: { tableMin: 2, tableMax: 19, multMax: 15 }, hard: { tableMin: 2, tableMax: 25, multMax: 20 } },
    generate: function (s, diff) {
      var tmin = Math.max(2, Math.min(30, s.tableMin | 0));
      var tmax = Math.max(tmin, Math.min(30, s.tableMax | 0));
      var mmax = Math.max(5, Math.min(50, s.multMax | 0));
      var a = R(tmin, tmax), b = R(2, mmax);
      return Q('tables', 'table-fact', diff, a + ' × ' + b, A.integer(a * b),
        'Table of ' + a + ': ' + a + ' \u00d7 ' + b + ' = ' + (a * b) + '.',
        { table: a, multiplier: b });
    }
  });

  /* ------------------------------------------------------------ 6. squares */

  topic({
    id: 'squares', label: 'Squares', group: 'Powers & roots',
    settings: [{ key: 'baseMax', label: 'Largest base', type: 'int', min: 10, max: 500, step: 5, def: 30 }],
    presets: { easy: { baseMax: 30 }, medium: { baseMax: 100 }, hard: { baseMax: 200 } },
    generate: function (s, diff) {
      var max = Math.max(10, Math.min(500, s.baseMax | 0));
      var pattern = weightedPick([
        ['ending-5', max >= 25 ? 25 : 0],
        ['near-50', max >= 50 ? 30 : 0],
        ['near-100', max >= 100 ? 25 : 0],
        ['general', 40]
      ]);

      if (pattern === 'ending-5') {
        var a5 = R(1, Math.floor(max / 10));
        var n = a5 * 10 + 5, val = n * n;
        return Q('squares', 'ending-5', diff, n + '\u00b2', A.integer(val),
          'n ending in 5: use a(a+1) followed by 25. Here ' + a5 + ' \u00d7 ' + (a5 + 1) + ' = ' +
          (a5 * (a5 + 1)) + ', so ' + n + '\u00b2 = ' + val + '.', { base: n });
      }

      if (pattern === 'near-50') {
        var off = R(1, 15) * (Math.random() < 0.5 ? -1 : 1);
        var nb = 50 + off, v = nb * nb;
        if (nb < 1 || nb > max) { nb = 50 + Math.abs(off); v = nb * nb; }
        return Q('squares', 'near-50', diff, nb + '\u00b2', A.integer(v),
          'Near 50: (50 ' + (off >= 0 ? '+' : '\u2212') + ' ' + Math.abs(off) + ')\u00b2 = 2500 ' +
          (off >= 0 ? '+' : '\u2212') + ' ' + (100 * Math.abs(off)) + ' + ' + (off * off) + ' = ' + v + '.',
          { base: nb });
      }

      if (pattern === 'near-100') {
        var d = R(1, 20) * (Math.random() < 0.5 ? -1 : 1);
        var b100 = 100 + d;
        if (b100 > max) b100 = 100 - Math.abs(d);
        var v100 = b100 * b100;
        return Q('squares', 'near-100', diff, b100 + '\u00b2', A.integer(v100),
          'Near 100: (100 ' + (d >= 0 ? '+' : '\u2212') + ' ' + Math.abs(d) + ')\u00b2 = 10000 ' +
          (d >= 0 ? '+' : '\u2212') + ' ' + (200 * Math.abs(d)) + ' + ' + (d * d) + ' = ' + v100 + '.',
          { base: b100 });
      }

      var n2 = R(11, max), val2 = n2 * n2;
      return Q('squares', 'general', diff, n2 + '\u00b2', A.integer(val2),
        'Use (a + b)\u00b2 = a\u00b2 + 2ab + b\u00b2. For ' + n2 + '\u00b2 take a = ' +
        (Math.floor(n2 / 10) * 10) + ', b = ' + (n2 % 10) + ': ' +
        (Math.floor(n2 / 10) * 10) + '\u00b2 + 2\u00d7' + (Math.floor(n2 / 10) * 10) + '\u00d7' + (n2 % 10) +
        ' + ' + (n2 % 10) + '\u00b2 = ' + val2 + '.', { base: n2 });
    }
  });

  /* -------------------------------------------------------------- 7. cubes */

  topic({
    id: 'cubes', label: 'Cubes', group: 'Powers & roots',
    settings: [{ key: 'baseMax', label: 'Largest base', type: 'int', min: 5, max: 200, step: 5, def: 20 }],
    presets: { easy: { baseMax: 20 }, medium: { baseMax: 30 }, hard: { baseMax: 50 } },
    generate: function (s, diff) {
      var max = Math.max(5, Math.min(200, s.baseMax | 0));
      var n = R(4, max), v = n * n * n;
      var a = Math.floor(n / 10) * 10, b = n % 10;
      var expl = a > 0
        ? 'Use (a + b)\u00b3 = a\u00b3 + 3a\u00b2b + 3ab\u00b2 + b\u00b3. Take a = ' + a + ', b = ' + b + ': ' +
          (a * a * a) + ' + ' + (3 * a * a * b) + ' + ' + (3 * a * b * b) + ' + ' + (b * b * b) + ' = ' + v + '.'
        : n + '\u00b3 = ' + n + ' \u00d7 ' + n + ' \u00d7 ' + n + ' = ' + v + '.';
      return Q('cubes', 'cube', diff, n + '\u00b3', A.integer(v), expl, { base: n });
    }
  });

  /* ------------------------------------------------------- 8. square roots */

  topic({
    id: 'squareroot', label: 'Square roots', group: 'Powers & roots',
    settings: [
      { key: 'rootMax', label: 'Largest root', type: 'int', min: 10, max: 500, step: 5, def: 30 },
      { key: 'mode', label: 'Mode', type: 'select', def: 'exact',
        options: [{ value: 'exact', label: 'Perfect squares only' }, { value: 'approx', label: 'Approximate (2 dp)' }] }
    ],
    presets: { easy: { rootMax: 30, mode: 'exact' }, medium: { rootMax: 100, mode: 'exact' }, hard: { rootMax: 200, mode: 'exact' } },
    generate: function (s, diff) {
      var rmax = Math.max(10, Math.min(500, s.rootMax | 0));
      if (s.mode === 'approx') {
        var x = R(1, rmax * rmax);
        var root = Math.sqrt(x);
        var ans = roundTo(root, 2);
        return Q('squareroot', 'approx', diff, '\u221a' + x + ' (2 dp)', A.decimal(root, 2),
          'Approximate: find the nearest perfect squares either side, then interpolate. \u221a' + x +
          ' \u2248 ' + ans.toFixed(2) + '.', { radicand: x });
      }
      var n = R(11, rmax), sq = n * n;
      var lastMap = { 1: '1 or 9', 4: '2 or 8', 9: '3 or 7', 6: '4 or 6', 5: '5', 0: '0' };
      var lo = Math.floor(n / 10) * 10, hiTen = lo + 10;
      return Q('squareroot', 'perfect-square', diff, '\u221a' + sq, A.integer(n),
        'A perfect square ending in ' + (sq % 10) + ' has a root ending in ' +
        lastMap[sq % 10] + '. The root is between ' + lo + ' and ' + hiTen +
        ', which selects ' + n + '.', { radicand: sq, root: n });
    }
  });

  /* --------------------------------------------------------- 9. cube roots */

  topic({
    id: 'cuberoot', label: 'Cube roots', group: 'Powers & roots',
    settings: [{ key: 'rootMax', label: 'Largest root', type: 'int', min: 5, max: 200, step: 5, def: 20 }],
    presets: { easy: { rootMax: 20 }, medium: { rootMax: 50 }, hard: { rootMax: 100 } },
    generate: function (s, diff) {
      var rmax = Math.max(5, Math.min(200, s.rootMax | 0));
      var n = R(4, rmax), cube = n * n * n;
      var lastMap = { 1: '1', 8: '2', 7: '3', 4: '4', 5: '5', 6: '6', 3: '7', 2: '8', 9: '9', 0: '0' };
      var lastDigit = cube % 10;
      var lead = Math.floor(cube / 1000);
      return Q('cuberoot', 'perfect-cube', diff, '\u00b3\u221a' + cube, A.integer(n),
        'Cube roots are unique in their last digit: a cube ending in ' + lastDigit + ' has a root ending in ' +
        lastMap[lastDigit] + '. Strike the last three digits (' + lead + ') and find which cube it falls under ' +
        '(it lies between ' + Math.pow(Math.max(0, Math.floor(Math.cbrt(lead))), 3) + ' and ' +
        Math.pow(Math.floor(Math.cbrt(lead)) + 1, 3) + '), giving ' + n + '.',
        { radicand: cube, root: n });
    }
  });

  /* -------------------------------------------------------- 10. powers */

  topic({
    id: 'powers', label: 'Powers & exponents', group: 'Powers & roots',
    settings: [
      { key: 'baseMax', label: 'Largest base', type: 'int', min: 2, max: 25, step: 1, def: 12 },
      { key: 'expMax', label: 'Largest exponent', type: 'int', min: 2, max: 4, step: 1, def: 3 }
    ],
    presets: { easy: { baseMax: 10, expMax: 2 }, medium: { baseMax: 12, expMax: 3 }, hard: { baseMax: 15, expMax: 4 } },
    generate: function (s, diff) {
      var bmax = Math.max(2, Math.min(25, s.baseMax | 0));
      var emax = Math.max(2, Math.min(4, s.expMax | 0));
      var useLaw = diff === 'hard' && Math.random() < 0.4;
      var a = R(2, bmax);

      if (useLaw) {
        var m = R(2, emax), n = R(2, emax);
        var v = Math.pow(a, m + n);
        if (v <= 1e9) {
          return Q('powers', 'law-of-indices', diff, a + '^' + m + ' \u00d7 ' + a + '^' + n, A.integer(v),
            'Same base, multiply \u2192 add the indices: ' + a + '^' + m + ' \u00d7 ' + a + '^' + n +
            ' = ' + a + '^' + (m + n) + ' = ' + v + '.', { base: a, m: m, n: n });
        }
      }

      var e = R(2, emax);
      var val = Math.pow(a, e);
      while (val > 1e9 && e > 2) { e--; val = Math.pow(a, e); }
      var parts = [];
      for (var i = 0; i < e; i++) parts.push(a);
      return Q('powers', 'power', diff, a + '^' + e, A.integer(val),
        a + '^' + e + ' means ' + parts.join(' \u00d7 ') + ' = ' + val + '.', { base: a, exp: e });
    }
  });

  /* ---------------------------------------------------- 11. percentages */

  topic({
    id: 'percentage', label: 'Percentages', group: 'Percentage',
    settings: [
      { key: 'subtype', label: 'Question type', type: 'select', def: 'auto',
        options: [
          { value: 'auto', label: 'Mixed' },
          { value: 'of', label: 'x% of a number' },
          { value: 'increase', label: 'x% increase' },
          { value: 'decrease', label: 'x% decrease' },
          { value: 'successive', label: 'Successive change' },
          { value: 'what-percent', label: 'What percent is one number of another' }
        ] },
      { key: 'maxNumber', label: 'Largest base number', type: 'int', min: 10, max: 100000, step: 10, def: 1000 }
    ],
    presets: { easy: { subtype: 'of', maxNumber: 200 }, medium: { subtype: 'auto', maxNumber: 1000 }, hard: { subtype: 'auto', maxNumber: 5000 } },
    generate: function (s, diff) {
      var maxN = Math.max(10, Math.min(100000, s.maxNumber | 0));
      var sub = s.subtype === 'auto' ? pick(['of', 'of', 'increase', 'decrease', 'successive', 'what-percent']) : s.subtype;
      var p = pick(PCT_FRIENDLY);
      var frac = pctFrac(p);                       // p/100 as reduced fraction
      var eq = pctEquivalent(p);
      var eqTxt = eq ? (p + '% = ' + eq.f[0] + '/' + eq.f[1]) : (p + '%');

      if (sub === 'of') {
        var kmax = Math.max(1, Math.floor(maxN / frac.den));
        var base = frac.den * R(1, kmax);
        var val = frac.num * (base / frac.den);      // exact by construction
        return Q('percentage', 'percent-of', diff, p + '% of ' + base, A.integer(val),
          'Use the fraction equivalent: ' + eqTxt + ', so ' + base + ' \u00f7 ' + frac.den + ' \u00d7 ' +
          frac.num + ' = ' + val + '.', { percent: p, base: base });
      }

      if (sub === 'increase' || sub === 'decrease') {
        var sign = sub === 'increase' ? 1 : -1;
        var mult = sign > 0 ? simplify(100 + p, 100) : simplify(100 - p, 100);
        if (!isInt(p)) { var p10 = Math.round(p * 10); mult = sign > 0 ? simplify(1000 + p10, 1000) : simplify(1000 - p10, 1000); }
        var kk = Math.max(1, Math.floor(maxN / mult.den));
        var base2 = mult.den * R(1, Math.max(1, kk));
        var res = mult.num * (base2 / mult.den);
        var dirTxt = sign > 0 ? 'increased' : 'decreased';
        return Q('percentage', 'percent-' + sub, diff,
          base2 + ' ' + dirTxt + ' by ' + p + '%', A.integer(res),
          'A ' + p + '% ' + sub + ' multiplies by ' + (sign > 0 ? (100 + p) : (100 - p)) + '/100. ' +
          base2 + ' \u00d7 ' + mult.num + ' \u00f7 ' + mult.den + ' = ' + res + '.',
          { percent: p, base: base2 });
      }

      if (sub === 'successive') {
        var intPcts = PCT_FRIENDLY.filter(isInt);
        var p1 = pick(intPcts), p2 = pick(intPcts);
        var net = simplify((100 + p1) * (100 - p2), 10000);
        var kN = Math.max(1, Math.floor(Math.max(10, maxN) / net.den));
        var base3 = net.den * R(1, kN);
        var res3 = net.num * (base3 / net.den);
        return Q('percentage', 'successive', diff,
          'A number ' + base3 + ' is first increased by ' + p1 + '% and then decreased by ' + p2 + '%',
          A.integer(res3),
          'Chain the multipliers: (' + (100 + p1) + '/100) \u00d7 (' + (100 - p2) + '/100) = ' +
          net.num + '/' + net.den + ', so ' + base3 + ' \u00d7 ' + net.num + ' \u00f7 ' + net.den + ' = ' +
          res3 + '. Net change = ' + roundTo((net.num / net.den) * 100 - 100, 2) + '%.',
          { percent: [p1, p2], base: base3 });
      }

      // what-percent
      var m2 = Math.max(1, Math.floor(maxN / frac.den));
      var denom = frac.den * R(1, Math.max(1, m2));
      var part = frac.num * (denom / frac.den);
      return Q('percentage', 'what-percent', diff,
        part + ' is what percent of ' + denom + '?', A.percentage(p, Math.max(1, decimalsOf(p))),
        'Divide and multiply by 100: ' + part + ' \u00f7 ' + denom + ' \u00d7 100 = ' + p + '%. ' + eqTxt + '.',
        { percent: p, base: denom });
    }
  });

  function pctFrac(p) {                          // p% as an exact reduced fraction
    if (isInt(p)) return simplify(p, 100);
    return simplify(Math.round(p * 10), 1000);
  }

  /* Exact percentage text for a fraction f = [num, den].
   * 1/3 -> "33 1/3", 1/8 -> "12.5", 1/4 -> "25". Used so a question like
   * "16 2/3% as a fraction" is literally true (16 2/3% = 1/6 exactly). */
  function percentText(f) {
    var s = simplify(100 * f[0], f[1]);            // the exact percentage as a fraction
    if (s.den === 1) return String(s.num);
    var t = s.den;                                  // terminating decimal iff den = 2^a * 5^b
    while (t % 2 === 0) t /= 2;
    while (t % 5 === 0) t /= 5;
    if (t === 1) return String(roundTo(s.num / s.den, 6));
    var whole = Math.floor(s.num / s.den);
    var rem = simplify(s.num - whole * s.den, s.den);
    return whole === 0 ? (rem.num + '/' + rem.den) : (whole + ' ' + rem.num + '/' + rem.den);
  }

  /* --------------------------------------------- 12. fraction → percentage */

  topic({
    id: 'fraction-to-percent', label: 'Fraction \u2192 percentage', group: 'Percentage',
    settings: [{ key: 'denMax', label: 'Largest denominator', type: 'int', min: 2, max: 24, step: 1, def: 12 }],
    presets: { easy: { denMax: 8 }, medium: { denMax: 12 }, hard: { denMax: 24 } },
    generate: function (s, diff) {
      var dmax = Math.max(2, Math.min(24, s.denMax | 0));
      var cands = FRACTION_PERCENT.filter(function (e) { return e.f[1] <= dmax; });
      if (!cands.length) cands = FRACTION_PERCENT.slice(0, 4);
      var e = pick(cands);
      if (diff !== 'easy' && Math.random() < 0.35) {
        // multiply numerator & denominator by 2 to require simplification awareness
        e = { f: [e.f[0] * 2, e.f[1] * 2] };
      }
      var exactPct = simplify(100 * e.f[0], e.f[1]);   // the exact percentage, as a fraction
      var term = exactPct.den;                          // recurring unless the denominator is 2^a * 5^b
      while (term % 2 === 0) term /= 2;
      while (term % 5 === 0) term /= 5;
      var recurring = term !== 1;
      var exactVal = roundTo(exactPct.num / exactPct.den, 6);
      var value = recurring ? roundTo(exactVal, 2) : exactVal;
      var places = recurring ? 2 : Math.max(1, decimalsOf(value));
      return Q('fraction-to-percent', 'known-equivalent', diff,
        e.f[0] + '/' + e.f[1] + ' as a percentage' +
        (recurring ? ', rounded to 2 decimal places' : ''),
        A.percentage(value, places),
        'Multiply by 100: ' + e.f[0] + '/' + e.f[1] + ' \u00d7 100 = ' + exactVal + '%' +
        (recurring ? ' (a recurring decimal). Rounded to 2 decimal places: ' + value + '%.' : '.'),
        { num: e.f[0], den: e.f[1] });
    }
  });

  /* --------------------------------------------- 13. percentage → fraction */

  topic({
    id: 'percent-to-fraction', label: 'Percentage \u2192 fraction', group: 'Percentage',
    settings: [{ key: 'pool', label: 'Percentages used', type: 'select', def: 'common',
      options: [{ value: 'common', label: 'Common exam percentages' }, { value: 'all', label: 'All equivalents' }] }],
    presets: { easy: { pool: 'common' }, medium: { pool: 'common' }, hard: { pool: 'all' } },
    generate: function (s, diff) {
      var pool = s.pool === 'all' ? FRACTION_PERCENT : FRACTION_PERCENT.filter(function (e) {
        return [2, 3, 4, 5, 8, 10, 16, 20, 25, 40].indexOf(e.f[1]) !== -1;
      });
      var e = pick(pool);
      var s2 = simplify(e.f[0], e.f[1]);
      var pctText = percentText(e.f);              // exact: "33 1/3", "12.5", "25" …
      return Q('percent-to-fraction', 'known-equivalent', diff,
        pctText + '% as a fraction in lowest terms', A.fraction(s2.num, s2.den, true),
        'Work backwards: ' + s2.num + '/' + s2.den + ' \u00d7 100 = ' + pctText + '%, so ' +
        pctText + '% = ' + s2.num + '/' + s2.den + '.',
        { percent: e.p });
    }
  });

  /* ------------------------------------------------ 14. fraction arithmetic */

  topic({
    id: 'fraction-arithmetic', label: 'Fraction arithmetic', group: 'Fractions',
    settings: [
      { key: 'denMax', label: 'Largest denominator', type: 'int', min: 2, max: 24, step: 1, def: 12 },
      { key: 'op', label: 'Operation', type: 'select', def: 'add',
        options: [{ value: 'add', label: 'Addition' }, { value: 'sub', label: 'Subtraction' },
                  { value: 'mul', label: 'Multiplication' }, { value: 'div', label: 'Division' }] }
    ],
    presets: { easy: { denMax: 8, op: 'add' }, medium: { denMax: 12, op: 'add' }, hard: { denMax: 16, op: 'div' } },
    generate: function (s, diff) {
      var dmax = Math.max(2, Math.min(24, s.denMax | 0));
      var b = R(2, dmax), d = R(2, dmax);
      var a = R(1, b - 1), c = R(1, d - 1);
      var op = s.op;
      var num, den, prompt, expl;

      if (op === 'add') {
        num = a * d + c * b; den = b * d;
        expl = 'LCM of ' + b + ' and ' + d + ' is ' + lcm(b, d) + '. Convert both fractions to that ' +
               'denominator, add the numerators, then cancel: ' + a + '/' + b + ' + ' + c + '/' + d + ' = ' +
               (num) + '/' + (den) + '.';
        prompt = a + '/' + b + ' + ' + c + '/' + d;
      } else if (op === 'sub') {
        if (a / b < c / d) { var t = [a, b, c, d]; a = t[2]; b = t[3]; c = t[0]; d = t[1]; }
        num = a * d - c * b; den = b * d;
        expl = 'LCM method: common denominator ' + lcm(b, d) + ', subtract the numerators, then cancel.';
        prompt = a + '/' + b + ' \u2212 ' + c + '/' + d;
      } else if (op === 'mul') {
        num = a * c; den = b * d;
        expl = 'Multiply across, then cancel common factors: (' + a + ' \u00d7 ' + c + ') / (' + b + ' \u00d7 ' + d + ').';
        prompt = a + '/' + b + ' × ' + c + '/' + d;
      } else {
        num = a * d; den = b * c;
        expl = 'Divide by multiplying by the reciprocal: ' + a + '/' + b + ' \u00d7 ' + d + '/' + c + ', then cancel.';
        prompt = a + '/' + b + ' ÷ ' + c + '/' + d;
      }

      if (den === 0) { return TOPICS['fraction-arithmetic'].generate({ denMax: 8, op: 'add' }, diff); }
      return Q('fraction-arithmetic', op, diff, prompt,
        A.fraction(num, den, true),
        expl + ' Lowest terms: ' + simplify(num, den).num + '/' + simplify(num, den).den + '.',
        { op: op });
    }
  });

  /* ---------------------------------------------------------- 15. BODMAS */

  topic({
    id: 'bodmas', label: 'BODMAS / simplification', group: 'Simplification',
    settings: [
      { key: 'terms', label: 'Number of terms', type: 'int', min: 3, max: 7, step: 1, def: 4 },
      { key: 'brackets', label: 'Allow brackets', type: 'checkbox', def: true },
      { key: 'digitMax', label: 'Largest number (digits)', type: 'int', min: 1, max: 3, step: 1, def: 2 },
      { key: 'usePercent', label: 'Include "x% of"', type: 'checkbox', def: false },
      { key: 'useFractionOf', label: 'Include "x/y of"', type: 'checkbox', def: false },
      { key: 'useRoots', label: 'Include square roots', type: 'checkbox', def: false }
    ],
    presets: {
      easy:   { terms: 3, brackets: false, digitMax: 1, usePercent: false, useFractionOf: false, useRoots: false },
      medium: { terms: 4, brackets: true, digitMax: 2, usePercent: false, useFractionOf: false, useRoots: false },
      hard:   { terms: 6, brackets: true, digitMax: 2, usePercent: true, useFractionOf: true, useRoots: true }
    },
    generate: function (s, diff) {
      var terms = Math.max(3, Math.min(7, s.terms | 0));
      var digits = Math.max(1, Math.min(3, s.digitMax | 0));
      var hi = pow10(digits) - 1;
      var lo = digits <= 1 ? 2 : pow10(digits - 1);

      for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        var useBracket = !!s.brackets && terms >= 4 && Math.random() < 0.6;
        var tokens = fixBrackets(useBracket, terms, lo, hi, s);
        if (!tokens) continue;
        var r = evaluate(tokens);
        if (r && r.allInt && r.value >= 0 && r.maxAbs <= 50000) {
          return Q('bodmas', 'simplify', diff, render(tokens), A.integer(r.value),
            'BODMAS order \u2014 ' + r.steps.join('; ') + '.', { tokens: tokens });
        }
      }

      // Guaranteed-valid fallback: a simple two-term expression.
      var x = R(lo, hi), y = R(lo, hi);
      var useMul = Math.random() < 0.5;
      var fbTokens = [{ t: 'num', v: x }, { t: 'op', op: useMul ? '×' : '+' }, { t: 'num', v: y }];
      var fb = evaluate(fbTokens);
      return Q('bodmas', 'simplify-fallback', diff, render(fbTokens), A.integer(fb.value),
        'BODMAS order \u2014 ' + fb.steps.join('; ') + '.', { tokens: fbTokens });
    }
  });

  function fixBrackets(useBracket, terms, lo, hi, s) {
    // Build a correctly ordered token list: atoms joined by operators, with one
    // parenthesised sub-run when brackets are enabled.
    var mkAtom = function () {
      if (s.useRoots && Math.random() < 0.18) {
        var r = R(3, 20); return { tk: [{ t: 'root', v: r * r }], text: '\u221a' + (r * r) };
      }
      if (s.usePercent && Math.random() < 0.18) {
        var p = pick([10, 20, 25, 50]);
        var base = (100 / gcd(p, 100)) * R(2, 12);
        return { tk: [{ t: 'pct', v: p }, { t: 'op', op: 'of' }, { t: 'num', v: base }], text: p + '% of ' + base };
      }
      if (s.useFractionOf && Math.random() < 0.18) {
        var d = R(2, 6), nu = R(1, d - 1), m = R(1, 5);
        return { tk: [{ t: 'frac', n: nu, d: d, baseMult: m }], text: nu + '/' + d + ' of ' + (d * m) };
      }
      var v = R(lo, hi);
      return { tk: [{ t: 'num', v: v }], text: String(v) };
    };

    var atoms = [], ops = [];
    for (var i = 0; i < terms; i++) { atoms.push(mkAtom()); if (i < terms - 1) ops.push(pick(['+', '-', '×', '÷'])); }

    var tokens = [];
    if (useBracket) {
      var bidx = R(0, terms - 2);                  // bracket covers atoms[bidx] op atoms[bidx+1]
      for (var j = 0; j < terms; j++) {
        if (j === bidx) tokens.push({ t: 'lp' });
        tokens = tokens.concat(atoms[j].tk);
        if (j === bidx + 1) tokens.push({ t: 'rp' });
        if (j < terms - 1) tokens.push({ t: 'op', op: ops[j] });
      }
    } else {
      for (var k = 0; k < terms; k++) {
        tokens = tokens.concat(atoms[k].tk);
        if (k < terms - 1) tokens.push({ t: 'op', op: ops[k] });
      }
    }
    return tokens;
  }

  function render(tokens) {
    var parts = [];
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      switch (tk.t) {
        case 'num': parts.push(String(tk.v)); break;
        case 'pct': parts.push(tk.v + '%'); break;
        case 'op': parts.push(tk.op === 'of' ? 'of' : tk.op); break;
        case 'lp': parts.push('('); break;
        case 'rp': parts.push(')'); break;
        case 'root': parts.push('\u221a' + tk.v); break;
        case 'frac': parts.push(tk.n + '/' + tk.d + ' of ' + (tk.d * tk.baseMult)); break;
        default: break;
      }
    }
    return parts.join(' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Recursive-descent evaluator. Single source of truth for the answer and the
   * step-by-step explanation, so the two can never disagree. */
  function evaluate(tokens) {
    var i = 0, steps = [], ok = true, allInt = true, maxAbs = 0;

    function note(v) {
      if (!isInt(v)) allInt = false;
      var m = Math.abs(v);
      if (m > maxAbs) maxAbs = m;
      return v;
    }

    function peek() { return i < tokens.length ? tokens[i] : null; }
    function next() { return tokens[i++]; }

    function primary() {
      var tk = peek();
      if (!tk) { ok = false; return { value: 0, text: '' }; }
      if (tk.t === 'num') { next(); return { value: note(tk.v), text: String(tk.v) }; }
      if (tk.t === 'pct') { next(); return { value: tk.v, text: tk.v + '%' }; }
      if (tk.t === 'root') { next(); var r = Math.sqrt(tk.v); note(r); return { value: r, text: '\u221a' + tk.v }; }
      if (tk.t === 'frac') {
        next();
        var base = tk.d * tk.baseMult;
        var v = tk.n * tk.baseMult;
        return { value: v, text: tk.n + '/' + tk.d + ' of ' + base };
      }
      if (tk.t === 'lp') {
        next();
        var inner = expr();
        if (peek() && peek().t === 'rp') next(); else { ok = false; }
        return { value: inner.value, text: '(' + inner.text + ')' };
      }
      ok = false; return { value: 0, text: '' };
    }

    function ofLevel() {
      var left = primary();
      while (peek() && peek().t === 'op' && peek().op === 'of') {
        next();
        var right = primary();
        var v = left.value / 100 * right.value;
        note(v);
        steps.push(left.text + ' of ' + right.text + ' = ' + trim(v));
        left = { value: v, text: left.text + ' of ' + right.text };
      }
      return left;
    }

    function term() {
      var left = ofLevel();
      while (peek() && peek().t === 'op' && (peek().op === '×' || peek().op === '÷')) {
        var op = next().op;
        var right = ofLevel();
        if (op === '÷' && right.value === 0) { ok = false; return { value: 0, text: '' }; }
        var v = op === '×' ? left.value * right.value : left.value / right.value;
        note(v);
        steps.push(left.text + ' ' + op + ' ' + right.text + ' = ' + trim(v));
        left = { value: v, text: left.text + ' ' + op + ' ' + right.text };
      }
      return left;
    }

    function expr() {
      var left = term();
      while (peek() && peek().t === 'op' && (peek().op === '+' || peek().op === '-')) {
        var op = next().op;
        var right = term();
        var v = op === '+' ? left.value + right.value : left.value - right.value;
        steps.push(left.text + ' ' + op + ' ' + right.text + ' = ' + trim(v));
        left = { value: v, text: left.text + ' ' + op + ' ' + right.text };
      }
      return left;
    }

    var result = expr();
    if (!ok || i !== tokens.length) return null;
    return { value: result.value, steps: steps, allInt: allInt, maxAbs: maxAbs };
  }

  function trim(v) { return isInt(v) ? String(v) : String(roundTo(v, 4)); }

  /* -------------------------------------------------- 16. mixed arithmetic */

  topic({
    id: 'mixed-arithmetic', label: 'Mixed arithmetic', group: 'Simplification',
    settings: [
      { key: 'steps', label: 'Operations', type: 'int', min: 2, max: 4, step: 1, def: 3 },
      { key: 'digitMax', label: 'Largest number (digits)', type: 'int', min: 1, max: 4, step: 1, def: 2 }
    ],
    presets: { easy: { steps: 2, digitMax: 1 }, medium: { steps: 3, digitMax: 2 }, hard: { steps: 4, digitMax: 3 } },
    generate: function (s, diff) {
      var steps = Math.max(2, Math.min(4, s.steps | 0));
      var digits = Math.max(1, Math.min(4, s.digitMax | 0));
      var hi = pow10(digits) - 1, lo = digits <= 1 ? 2 : pow10(digits - 1);

      for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        var kind = pick(['aopb', 'percent-plus', 'square-minus', 'divide-then']);
        var tokens;

        if (kind === 'aopb') {
          var a = R(lo, hi), b = R(lo, hi), c = R(lo, hi);
          var op1 = pick(['×', '+', '-']);
          tokens = [{ t: 'num', v: a }, { t: 'op', op: op1 }, { t: 'num', v: b }];
          if (steps >= 3) tokens.push({ t: 'op', op: pick(['+', '-', '×']) }, { t: 'num', v: c });
          var r = evaluate(tokens);
          if (r && r.allInt && r.value >= 0 && r.maxAbs <= 50000) {
            return Q('mixed-arithmetic', 'multi-step', diff, render(tokens), A.integer(r.value),
              'BODMAS order \u2014 ' + r.steps.join('; ') + '.', { tokens: tokens });
          }
        }
        if (kind === 'percent-plus') {
          var p = pick([10, 20, 25, 50, 5, 15]);
          var f = pctFrac(p);
          var base = f.den * R(1, Math.max(1, Math.floor(hi / f.den)));
          var extra = R(1, hi);
          tokens = [{ t: 'pct', v: p }, { t: 'op', op: 'of' }, { t: 'num', v: base }, { t: 'op', op: '+' }, { t: 'num', v: extra }];
          var r2 = evaluate(tokens);
          if (r2 && r2.allInt && r2.value >= 0 && r2.maxAbs <= 50000) {
            return Q('mixed-arithmetic', 'percent-of-plus', diff, render(tokens), A.integer(r2.value),
              'BODMAS order \u2014 ' + r2.steps.join('; ') + '.', { tokens: tokens });
          }
        }
        if (kind === 'square-minus') {
          var q = R(2, 12);
          tokens = [{ t: 'root', v: q * q }, { t: 'op', op: pick(['+', '×', '-']) }, { t: 'num', v: R(lo, hi) }];
          var r3 = evaluate(tokens);
          if (r3 && r3.allInt && r3.value >= 0 && r3.maxAbs <= 50000) {
            return Q('mixed-arithmetic', 'root-term', diff, render(tokens), A.integer(r3.value),
              'BODMAS order \u2014 ' + r3.steps.join('; ') + '.', { tokens: tokens });
          }
        }
        if (kind === 'divide-then') {
          var d = R(2, Math.max(3, Math.min(12, hi)));
          var qq = R(2, 12);
          tokens = [{ t: 'num', v: d * qq }, { t: 'op', op: '÷' }, { t: 'num', v: d }, { t: 'op', op: '+' }, { t: 'num', v: R(lo, hi) }];
          var r4 = evaluate(tokens);
          if (r4 && r4.allInt && r4.value >= 0 && r4.maxAbs <= 50000) {
            return Q('mixed-arithmetic', 'divide-then-add', diff, render(tokens), A.integer(r4.value),
              'BODMAS order \u2014 ' + r4.steps.join('; ') + '.', { tokens: tokens });
          }
        }
      }

      var fa = R(lo, hi), fb = R(lo, hi);
      return Q('mixed-arithmetic', 'fallback', diff, fa + ' + ' + fb, A.integer(fa + fb),
        'Simple addition: ' + fa + ' + ' + fb + ' = ' + (fa + fb) + '.', {});
    }
  });

  /* --------------------------------------------------- 17. number patterns */

  topic({
    id: 'number-patterns', label: 'Number patterns', group: 'Simplification',
    settings: [{ key: 'subtype', label: 'Pattern', type: 'select', def: 'auto',
      options: [
        { value: 'auto', label: 'Mixed' },
        { value: 'series', label: 'Sum of a series' },
        { value: 'difference-of-squares', label: 'Difference of squares' },
        { value: 'repdigit', label: 'Multiply by 11 / 111' },
        { value: 'digit-sum', label: 'Digit sum' }
      ] }],
    presets: { easy: { subtype: 'series' }, medium: { subtype: 'auto' }, hard: { subtype: 'auto' } },
    generate: function (s, diff) {
      var sub = s.subtype === 'auto' ? pick(['series', 'difference-of-squares', 'repdigit', 'digit-sum']) : s.subtype;

      if (sub === 'series') {
        var kind = pick(['natural', 'odd', 'even', 'range']);
        if (kind === 'natural') {
          var n = R(10, diff === 'hard' ? 100 : 50);
          var sum = n * (n + 1) / 2;
          return Q('number-patterns', 'sum-natural', diff, '1 + 2 + 3 + \u2026 + ' + n, A.integer(sum),
            'Sum of first n natural numbers = n(n+1)/2 = ' + n + '\u00d7' + (n + 1) + '/2 = ' + sum + '.',
            { n: n });
        }
        if (kind === 'odd') {
          var n2 = R(5, diff === 'hard' ? 60 : 30);
          var sum2 = n2 * n2;
          return Q('number-patterns', 'sum-odd', diff, 'Sum of the first ' + n2 + ' odd numbers', A.integer(sum2),
            'Sum of the first n odd numbers = n\u00b2 = ' + n2 + '\u00b2 = ' + sum2 + '.', { n: n2 });
        }
        if (kind === 'even') {
          var n3 = R(5, diff === 'hard' ? 60 : 30);
          var sum3 = n3 * (n3 + 1);
          return Q('number-patterns', 'sum-even', diff, 'Sum of the first ' + n3 + ' even numbers', A.integer(sum3),
            'Sum of the first n even numbers = n(n+1) = ' + n3 + '\u00d7' + (n3 + 1) + ' = ' + sum3 + '.', { n: n3 });
        }
        var a = R(10, 200), cnt = R(5, diff === 'hard' ? 40 : 15);
        var b = a + cnt - 1;
        var sum4 = (a + b) * cnt / 2;
        return Q('number-patterns', 'sum-range', diff, a + ' + ' + (a + 1) + ' + \u2026 + ' + b, A.integer(sum4),
          'Arithmetic series: (first + last) \u00d7 count / 2 = (' + a + ' + ' + b + ') \u00d7 ' + cnt +
          ' / 2 = ' + sum4 + '.', { a: a, b: b, count: cnt });
      }

      if (sub === 'difference-of-squares') {
        var x = R(11, 120), y = R(2, x - 1);
        var v = x * x - y * y;
        return Q('number-patterns', 'difference-of-squares', diff, x + '\u00b2 \u2212 ' + y + '\u00b2', A.integer(v),
          'Apply a\u00b2 \u2212 b\u00b2 = (a + b)(a \u2212 b): (' + x + ' + ' + y + ')(' + x + ' \u2212 ' + y +
          ') = ' + (x + y) + ' \u00d7 ' + (x - y) + ' = ' + v + '.',
          { a: x, b: y });
      }

      if (sub === 'repdigit') {
        var r = pick([11, 111, 1111]);
        var n4 = R(11, r === 1111 ? 99 : 999);
        var val = n4 * r;
        return Q('number-patterns', 'repdigit', diff, n4 + ' \u00d7 ' + r, A.integer(val),
          'Multiplying by ' + r + ': shift-and-add. ' + n4 + ' \u00d7 ' + r + ' = ' + val + '.',
          { a: n4, b: r });
      }

      var digitsN = R(1000, 99999);
      var str = String(digitsN), ds = 0;
      for (var i = 0; i < str.length; i++) ds += Number(str[i]);
      return Q('number-patterns', 'digit-sum', diff, 'Sum of the digits of ' + digitsN, A.integer(ds),
        'Add each digit: ' + str.split('').join(' + ') + ' = ' + ds + '.', { number: digitsN });
    }
  });

  /* ======================================================= MCQ distractors */

  function makeOptions(question, count) {
    count = count || 4;
    var correctText = answerText(question.answer);
    var texts = [correctText];
    var guard = 0;
    while (texts.length < count && guard++ < 300) {
      var cand = distractor(question, texts);
      if (cand && cand !== correctText && texts.indexOf(cand) === -1) texts.push(cand);
    }
    // Defensive: if a topic cannot supply enough distinct distractors, pad with
    // clearly-labelled alternates so MCQ never silently drops to one option.
    var pad = 1;
    while (texts.length < count) {
      var filler = correctText + ' \u00b1' + pad;
      if (texts.indexOf(filler) === -1) texts.push(filler);
      pad++;
      if (pad > 500) break;
    }

    var opts = texts.map(function (t) { return { text: t, correct: t === correctText }; });
    return shuffle(opts);
  }

  function answerText(answer) {
    if (!answer) return '—';
    switch (answer.type) {
      case 'integer': return String(answer.value);
      case 'decimal': return answer.value.toFixed(answer.places == null ? 2 : answer.places);
      case 'percentage': return String(roundTo(answer.value, answer.places == null ? 2 : answer.places)) + '%';
      case 'fraction': return answer.num + '/' + answer.den;
      case 'division': return answer.remainder ? answer.quotient + ' R ' + answer.remainder : String(answer.quotient);
      default: return '?';
    }
  }

  function distractor(question, existing) {
    var a = question.answer;
    var variant = null;
    var jitter = pick([-2, -1, 1, 2, -10, 10, -5, 5, -100, 100]);
    switch (a.type) {
      case 'integer': {
        if (Math.random() < 0.35) {
          // digit transposition (a very common slip)
          var s = String(Math.abs(a.value));
          if (s.length >= 2) {
            var idx = R(0, s.length - 2);
            var arr = s.split('');
            var t = arr[idx]; arr[idx] = arr[idx + 1]; arr[idx + 1] = t;
            variant = (a.value < 0 ? '-' : '') + arr.join('');
          }
        }
        if (variant == null) {
          var v = a.value + jitter;
          if (v === a.value) return null;
          variant = String(v);
        }
        break;
      }
      case 'decimal': {
        var places = a.places == null ? 2 : a.places;
        var step = Math.pow(10, -places);
        var d = roundTo(a.value + pick([-1, 1]) * step * pick([1, 2, 5, 10]), places);
        variant = d.toFixed(places);
        break;
      }
      case 'percentage': {
        var places2 = a.places == null ? 2 : a.places;
        var v2 = roundTo(a.value + pick([-5, -2, -1, -0.5, 0.5, 1, 2, 5]), places2);
        variant = String(v2) + '%';
        break;
      }
      case 'fraction': {
        var cands = [
          a.num + '/' + (a.den + 1),
          (a.num + 1) + '/' + a.den,
          (a.den) + '/' + (a.num || 1),
          (a.num + 1) + '/' + (a.den + 1),
          Math.max(1, a.num - 1) + '/' + a.den
        ];
        variant = pick(cands);
        break;
      }
      case 'division': {
        var q = a.quotient + pick([-2, -1, 1, 2]);
        var r = Math.max(0, a.remainder + pick([-1, 1]));
        variant = a.remainder ? q + ' R ' + r : String(q);
        break;
      }
      default: return null;
    }
    if (variant == null) return null;
    if (existing.indexOf(variant) !== -1) return null;
    return variant;
  }

  /* =============================================================== public */

  function listTopics() {
    return Object.keys(TOPICS).map(function (k) {
      var t = TOPICS[k];
      return { id: t.id, label: t.label, group: t.group };
    });
  }

  function getTopic(id) { return TOPICS[id] || null; }

  function defaultSettings(id, difficulty) {
    var t = TOPICS[id];
    if (!t) return {};
    var out = {};
    t.settings.forEach(function (f) { out[f.key] = f.def; });
    if (difficulty && t.presets && t.presets[difficulty]) {
      var p = t.presets[difficulty];
      Object.keys(p).forEach(function (k) { out[k] = p[k]; });
    }
    return out;
  }

  /** Clamp/normalise a settings object against the topic schema. */
  function sanitiseSettings(id, settings) {
    var t = TOPICS[id];
    if (!t) return {};
    var out = defaultSettings(id);
    if (settings) {
      t.settings.forEach(function (f) {
        if (!(f.key in settings)) return;
        var v = settings[f.key];
        if (f.type === 'int') {
          v = Math.round(Number(v));
          if (!isFinite(v)) return;
          out[f.key] = Math.max(f.min, Math.min(f.max, v));
        } else if (f.type === 'checkbox') {
          out[f.key] = !!v;
        } else if (f.type === 'select') {
          var ok = f.options.some(function (o) { return o.value === v; });
          if (ok) out[f.key] = v;
        }
      });
    }
    // topic-specific cross-field fixes
    if (id === 'tables' && out.tableMax < out.tableMin) out.tableMax = out.tableMin;
    return out;
  }

  /** Generate one validated question. Retries then falls back to a safe topic. */
  function generateQuestion(id, settings, difficulty) {
    var t = TOPICS[id];
    if (!t) throw new Error('Unknown topic: ' + id);
    var clean = sanitiseSettings(id, settings);
    for (var attempt = 0; attempt < 12; attempt++) {
      var q;
      try { q = t.generate(clean, difficulty || 'medium'); } catch (e) { q = null; }
      if (q && validateQuestion(q)) return q;
    }
    // Last resort: a trivially valid addition question so the session never breaks.
    return Q('addition', 'fallback', difficulty || 'medium',
      '7 + 8', A.integer(15), 'Simple addition: 7 + 8 = 15.', {});
  }

  // NOTE: the spec requires every explanation to describe the question it is
  // attached to. Each generator builds its explanation from the same numbers it
  // used to build the answer, so the two cannot drift apart.

  /** Structural validation of a generated question (spec §6/§19). */
  function validateQuestion(q) {
    if (!q || typeof q.prompt !== 'string' || !q.prompt) return false;
    if (!q.answer || typeof q.answer.type !== 'string') return false;
    if (/\bNaN\b|Infinity|undefined/.test(q.prompt)) return false;
    var a = q.answer;
    switch (a.type) {
      case 'integer':    return isFinite(a.value);
      case 'decimal':    return isFinite(a.value);
      case 'percentage': return isFinite(a.value);
      case 'fraction':   return a.den !== 0 && isFinite(a.num) && isFinite(a.den);
      case 'division':   return isFinite(a.quotient) && isFinite(a.remainder) &&
                                a.remainder >= 0 &&
                                (q.meta && q.meta.divisor ? a.remainder < q.meta.divisor : true);
      default:           return false;
    }
  }

  return {
    TOPICS: TOPICS,
    listTopics: listTopics,
    getTopic: getTopic,
    defaultSettings: defaultSettings,
    sanitiseSettings: sanitiseSettings,
    generateQuestion: generateQuestion,
    validateQuestion: validateQuestion,
    makeOptions: makeOptions,
    answerText: answerText,
    evaluateTokens: evaluate,
    renderTokens: render,
    // exposed for tests
    _util: { R: R, shuffle: shuffle, simplify: simplify, gcd: gcd, pctFrac: pctFrac, FRACTION_PERCENT: FRACTION_PERCENT }
  };
});
