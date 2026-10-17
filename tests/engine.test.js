/* =============================================================================
 * tests/engine.test.js — Node test runner entry point.
 *
 *   node --test tests/
 *
 * Loads the engine modules (they self-register on globalThis.SM) and runs the
 * shared cases in tests/cases.js. No dependencies, no framework, no build step.
 * ========================================================================== */
'use strict';

var test = require('node:test');
var assert = require('node:assert');

// The engine modules attach themselves to globalThis.SM as they load.
require('../js/validation.js');
require('../js/generators.js');
require('../js/timer.js');
require('../js/analytics.js');
require('../js/drills.js');

var cases = require('./cases.js');

if (!Array.isArray(cases) || cases.length === 0) {
  throw new Error('No test cases were loaded from tests/cases.js');
}

cases.forEach(function (c) {
  test(c.name, function () {
    c.fn(assert);
  });
});
