/* =============================================================================
 * timer.js — the timing engine.
 *
 * Every duration is derived from *timestamps*, never from decrementing a
 * counter (spec §8). This keeps timing correct when the browser throttles
 * timers in a background tab, where a setInterval-based counter would drift.
 *
 * Pause/resume accumulates only the time actually spent running, so paused
 * time can never leak into a session or response duration (spec §19).
 *
 * The clock is injectable so the logic can be unit-tested without real delays.
 * ========================================================================== */
;(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.SM = root.SM || {}; root.SM.timer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Monotonic-ish clock. performance.now() is preferred; Date.now() as fallback. */
  function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * @param {object}  [opts]
   * @param {'up'|'down'} [opts.direction='up']
   * @param {number}  [opts.durationMs]  required when direction is 'down'
   * @param {function} [opts.now]        injectable clock (tests)
   */
  function createTimer(opts) {
    opts = opts || {};
    var now = opts.now || defaultNow;
    var direction = opts.direction === 'down' ? 'down' : 'up';
    var durationMs = opts.durationMs == null ? null : Math.max(0, opts.durationMs);

    var running = false;
    var paused = false;
    var stopped = false;
    var accumulated = 0;   // frozen milliseconds from previous run segments
    var startedAt = 0;     // clock reading when the current segment began

    function read() {
      var extra = running ? Math.max(0, now() - startedAt) : 0;
      return accumulated + extra;
    }

    return {
      start: function () {
        if (running) return;
        accumulated = 0; startedAt = now();
        running = true; paused = false; stopped = false;
      },
      pause: function () {
        if (!running) return;
        accumulated += Math.max(0, now() - startedAt);
        running = false; paused = true;
      },
      resume: function () {
        if (running || stopped) return;
        startedAt = now();
        running = true; paused = false;
      },
      /** Freeze permanently; a stopped timer cannot be resumed. */
      stop: function () {
        if (running) { accumulated += Math.max(0, now() - startedAt); running = false; }
        stopped = true;
      },
      reset: function () {
        accumulated = 0; running = false; paused = false; stopped = false;
      },
      elapsedMs: read,
      remainingMs: function () {
        if (durationMs == null) return null;
        return Math.max(0, durationMs - read());
      },
      isRunning: function () { return running; },
      isPaused: function () { return paused && !stopped; },
      isStopped: function () { return stopped; },
      /** True once a countdown has reached zero. */
      isExpired: function () { return durationMs != null && read() >= durationMs; },
      getDurationMs: function () { return durationMs; },
      getDirection: function () { return direction; }
    };
  }

  /* ------------------------------------------------------------ formatting */

  /** "0:07", "2:41", "1:02:41" — for session clocks. */
  function formatDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    var ss = String(s).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  /** "3.4s" or "1m 12.5s" — for per-question response times. */
  function formatResponseTime(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    var sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var rem = sec - m * 60;
    return m + 'm ' + rem.toFixed(1) + 's';
  }

  return {
    defaultNow: defaultNow,
    createTimer: createTimer,
    formatDuration: formatDuration,
    formatResponseTime: formatResponseTime
  };
});
