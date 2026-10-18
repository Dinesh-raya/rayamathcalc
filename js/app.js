/* =============================================================================
 * app.js — screens, rendering and input handling.
 *
 * Bridges the pure engine (generators / validation / timer / analytics / drills)
 * to the DOM. All state lives in memory: nothing is written to localStorage or
 * sent anywhere, so a refresh intentionally loses the current drill.
 * ========================================================================== */
(function () {
  'use strict';

  var SM = window.SM || {};
  var V = SM.validation, G = SM.generators, T = SM.timer, AN = SM.analytics, D = SM.drills;

  /* ------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }

  /* Topic id -> sprite icon name (the symbols live in index.html). */
  var TOPIC_ICON = {
    'addition': 'plus',
    'subtraction': 'minus',
    'multiplication': 'times',
    'division': 'divide',
    'tables': 'grid',
    'squares': 'square',
    'cubes': 'cube',
    'squareroot': 'root',
    'cuberoot': 'root',
    'powers': 'zap',
    'percentage': 'percent',
    'fraction-to-percent': 'percent',
    'percent-to-fraction': 'fraction',
    'fraction-arithmetic': 'fraction',
    'bodmas': 'brackets',
    'mixed-arithmetic': 'calculator',
    'number-patterns': 'dots',
    'mixed': 'shuffle'
  };

  /* Metric label -> sprite icon name. */
  var METRIC_ICON = {
    'Questions shown': 'list',
    'Answered': 'list',
    'Correct': 'check',
    'Incorrect': 'x-circle',
    'Skipped': 'skip',
    'Timed out': 'clock',
    'Accuracy': 'target',
    'Correct of shown': 'chart',
    'Average response': 'clock',
    'Total time': 'clock',
    'Questions / min': 'zap',
    'Correct / min': 'trend',
    'Score': 'trophy',
    'Best streak': 'flame'
  };

  /* Markup for one sprite icon, e.g. icon('play') -> <svg ...><use href="#i-play"></use></svg>. */
  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' +
      name + '"></use></svg>';
  }

  function make(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }); }
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmt(v, suffix, dash) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return dash || '—';
    return v + (suffix || '');
  }
  var DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  /* --------------------------------------------------------------- state */

  var app = {
    screen: 'dashboard',
    config: null,
    session: null,
    results: null,
    records: [],
    reviewFilter: 'all',
    feedbackPending: false,
    tickHandle: null,
    autoHandle: null,
    settingsTouched: {},
    lastRunConfig: null,
    currentStreak: 0,
    bestStreak: 0,
    numpadOpen: false
  };

  function defaultMixedTopics() {
    return [
      { id: 'addition', weight: 20 },
      { id: 'multiplication', weight: 25 },
      { id: 'division', weight: 15 },
      { id: 'squares', weight: 10 },
      { id: 'squareroot', weight: 5 },
      { id: 'percentage', weight: 15 },
      { id: 'bodmas', weight: 10 }
    ];
  }

  function freshConfig() {
    return {
      topic: 'mixed',
      topics: defaultMixedTopics(),
      difficulty: 'medium',
      sessionType: 'fixed',
      questionCount: 10,
      durationMs: 5 * 60 * 1000,
      answerMode: 'input',
      mcqOptionCount: 4,
      feedback: 'immediate',
      autoAdvance: false,
      autoAdvanceMs: 1500,
      negativeMarking: false,
      negativeFraction: 0.25,
      perQuestionLimitMs: null,
      adaptive: false,
      topicSettings: {}
    };
  }

  /* ------------------------------------------------------- screen switch */

  var SCREENS = {
    dashboard: 'screen-dashboard',
    config: 'screen-config',
    practice: 'screen-practice',
    results: 'screen-results'
  };

  function showScreen(name) {
    Object.keys(SCREENS).forEach(function (k) {
      $(SCREENS[k]).hidden = (k !== name);
    });
    app.screen = name;
    if (name !== 'practice') stopTicking();
    var section = $(SCREENS[name]);
    var heading = section.querySelector('h1, h2');
    if (heading && name !== 'practice') {
      heading.setAttribute('tabindex', '-1');
      try { heading.focus(); } catch (e) { /* ignore */ }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    updateUnloadGuard();
  }

  /* --------------------------------------------------------- modal/toast */

  var modalState = { onClose: null, lastFocus: null };

  function openModal(opts) {
    var box = $('modalBox');
    box.className = 'modal' + (opts.modalClass ? ' ' + opts.modalClass : '');
    $('modalTitle').textContent = opts.title || 'Are you sure?';
    clear($('modalBody'));
    if (opts.bodyNode) $('modalBody').appendChild(opts.bodyNode);
    else if (opts.body) $('modalBody').innerHTML = opts.body;

    var actions = $('modalActions');
    clear(actions);
    (opts.actions || []).forEach(function (a) {
      actions.appendChild(make('button', {
        type: 'button', class: 'btn ' + (a.class || 'btn-outline'),
        onclick: function () { if (a.onClick) a.onClick(); if (a.close !== false) closeModal(); }
      }, a.label));
    });

    modalState.onClose = opts.onClose || null;
    modalState.lastFocus = document.activeElement;
    $('modal').hidden = false;
    var first = actions.querySelector('button');
    if (first) first.focus();
  }

  function closeModal() {
    if ($('modal').hidden) return;
    $('modal').hidden = true;
    $('modalBox').className = 'modal';
    var cb = modalState.onClose; modalState.onClose = null;
    if (modalState.lastFocus && modalState.lastFocus.focus) {
      try { modalState.lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    if (cb) cb();
  }

  var toastHandle = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    if (toastHandle) clearTimeout(toastHandle);
    toastHandle = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ======================================================== DASHBOARD == */

  var PRESETS = [
    {
      id: 'daily-warmup',
      title: 'Daily Exam Warm-up',
      badge: 'Mixed · 20 Qs',
      desc: 'Rapid mixed calculation warmup: addition, multiplication, division, and roots.',
      meta: '20 Questions · Medium',
      config: function () {
        var c = freshConfig();
        c.topic = 'mixed';
        c.questionCount = 20;
        c.difficulty = 'medium';
        return c;
      }
    },
    {
      id: 'tables-blitz',
      title: 'Tables Speed Blitz',
      badge: 'Tables · 3 Mins',
      desc: 'Master multiplication tables 12 to 25 under a 3-minute timed countdown.',
      meta: '3 Mins · Countdown',
      config: function () {
        var c = freshConfig();
        c.topic = 'tables';
        c.sessionType = 'countdown';
        c.durationMs = 3 * 60 * 1000;
        c.topicSettings['tables'] = { tableMin: 12, tableMax: 25, multiplierMax: 12 };
        return c;
      }
    },
    {
      id: 'squares-cubes',
      title: 'Squares & Cubes Sprint',
      badge: 'Powers · 20 Qs',
      desc: 'Squares up to 50 & cubes up to 30. Crucial for simplification & series.',
      meta: '20 Questions · Hard',
      config: function () {
        var c = freshConfig();
        c.topic = 'mixed';
        c.topics = [
          { id: 'squares', weight: 50 },
          { id: 'cubes', weight: 50 }
        ];
        c.questionCount = 20;
        c.difficulty = 'hard';
        return c;
      }
    },
    {
      id: 'bodmas-simplification',
      title: 'BODMAS Simplification',
      badge: 'Simplification',
      desc: 'Multi-step BODMAS operations with brackets, powers, and cancellation.',
      meta: '15 Questions · Medium',
      config: function () {
        var c = freshConfig();
        c.topic = 'bodmas';
        c.questionCount = 15;
        c.difficulty = 'medium';
        return c;
      }
    },
    {
      id: 'percent-reflex',
      title: 'Percent ↔ Fraction Reflex',
      badge: 'Percentages',
      desc: 'Instant reflex drills for 1/2 to 1/20 fraction and percentage conversions.',
      meta: '20 Questions · Medium',
      config: function () {
        var c = freshConfig();
        c.topic = 'mixed';
        c.topics = [
          { id: 'fraction-to-percent', weight: 50 },
          { id: 'percent-to-fraction', weight: 50 }
        ];
        c.questionCount = 20;
        c.difficulty = 'medium';
        return c;
      }
    }
  ];

  function renderPresetGrid() {
    var grid = $('presetGrid');
    if (!grid) return;
    clear(grid);
    PRESETS.forEach(function (p) {
      var card = make('button', {
        type: 'button', class: 'preset-card',
        onclick: function () { startSession(p.config()); }
      });
      var top = make('div', { class: 'preset-card-top' });
      top.appendChild(make('span', { class: 'preset-badge' }, p.badge));
      top.innerHTML += icon('bolt');
      card.appendChild(top);
      card.appendChild(make('strong', null, p.title));
      card.appendChild(make('p', { class: 'p-desc' }, p.desc));
      card.appendChild(make('div', { class: 'p-meta', html: icon('play') + '<span>' + p.meta + '</span>' }));
      grid.appendChild(card);
    });
  }

  function renderTopicGrid() {
    var grid = $('topicGrid');
    clear(grid);

    var mixed = make('button', { type: 'button', class: 'topic-card featured', onclick: function () { startConfig('mixed'); } });
    mixed.appendChild(make('span', { class: 'tc-top', html: icon(TOPIC_ICON.mixed) + '<span class="group">Recommended</span>' }));
    mixed.appendChild(make('strong', null, 'Mixed practice'));
    mixed.appendChild(make('span', { class: 'muted small' }, 'Blend topics with adjustable weights'));
    grid.appendChild(mixed);

    G.listTopics().forEach(function (t) {
      var card = make('button', { type: 'button', class: 'topic-card', onclick: function () { startConfig(t.id); } });
      card.appendChild(make('span', { class: 'tc-top', html: icon(TOPIC_ICON[t.id] || 'calculator') + '<span class="group">' + t.group + '</span>' }));
      card.appendChild(make('strong', null, t.label));
      grid.appendChild(card);
    });
  }

  /* =========================================================== CONFIG == */

  function startConfig(topicId) {
    if (!app.config) app.config = freshConfig();
    if (topicId) app.config.topic = topicId;
    if (!app.config.topicSettings[app.config.topic] && app.config.topic !== 'mixed') {
      app.config.topicSettings[app.config.topic] = G.defaultSettings(app.config.topic, app.config.difficulty);
    }
    renderConfig();
    showScreen('config');
  }

  function renderConfig() {
    var c = app.config;

    // topic select
    var sel = $('cfgTopic');
    clear(sel);
    sel.appendChild(make('option', { value: 'mixed' }, 'Mixed practice (several topics)'));
    var groups = {};
    G.listTopics().forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    Object.keys(groups).forEach(function (gname) {
      var og = make('optgroup', { label: gname });
      groups[gname].forEach(function (t) { og.appendChild(make('option', { value: t.id }, t.label)); });
      sel.appendChild(og);
    });
    sel.value = c.topic;

    renderDifficulty();
    $('cfgSessionType').value = c.sessionType;
    $('cfgCount').value = c.questionCount;
    $('cfgMinutes').value = Math.round((c.durationMs / 60000) * 10) / 10;
    $('cfgAnswerMode').value = c.answerMode;
    $('cfgMcqCount').value = c.mcqOptionCount;
    $('cfgFeedback').value = c.feedback;
    $('cfgAutoAdvance').checked = c.autoAdvance;
    $('cfgAutoAdvanceMs').value = c.autoAdvanceMs / 1000;
    $('cfgNegative').checked = c.negativeMarking;
    $('cfgNegativeFraction').value = String(c.negativeFraction);
    $('cfgPerQuestion').checked = !!c.perQuestionLimitMs;
    $('cfgPerQuestionSec').value = c.perQuestionLimitMs ? Math.round(c.perQuestionLimitMs / 1000) : 20;
    $('cfgAdaptive').checked = c.adaptive;

    toggleConditionalFields();
    renderTopicSettings();
    renderWeights();
    refreshValidation();
  }

  function renderDifficulty() {
    Array.prototype.forEach.call($('cfgDifficulty').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-diff') === app.config.difficulty));
    });
  }

  function toggleConditionalFields() {
    var c = app.config;
    $('wrapCount').hidden = c.sessionType !== 'fixed';
    $('wrapDuration').hidden = c.sessionType !== 'countdown';
    $('wrapMcqCount').hidden = c.answerMode !== 'mcq';
    $('wrapAutoAdvance').hidden = c.feedback !== 'immediate';
    $('wrapAutoAdvanceMs').hidden = !(c.feedback === 'immediate' && c.autoAdvance);
    $('wrapNegativeFraction').hidden = !c.negativeMarking;
    $('wrapPerQuestion').hidden = !c.perQuestionLimitMs;

    var isMixed = c.topic === 'mixed';
    $('cardWeights').hidden = !isMixed;
    $('cardTopicSettings').hidden = isMixed;

    var t = G.getTopic(c.topic);
    $('topicBlurb').textContent = isMixed
      ? 'Questions are drawn from the topics below according to their weights.'
      : 'Each topic has its own difficulty patterns and settings.';
  }

  function renderTopicSettings() {
    var c = app.config;
    var host = $('topicSettings');
    clear(host);
    if (c.topic === 'mixed') return;

    var topic = G.getTopic(c.topic);
    if (!topic) return;
    if (!c.topicSettings[c.topic]) {
      c.topicSettings[c.topic] = G.defaultSettings(c.topic, c.difficulty);
    }
    var settings = c.topicSettings[c.topic];

    topic.settings.forEach(function (f) {
      var row = make('div', { class: 'setting-row' });
      var id = 'set_' + c.topic + '_' + f.key;
      var input;

      if (f.type === 'checkbox') {
        var lab = make('label', { class: 'field checkbox' });
        input = make('input', { type: 'checkbox', id: id });
        input.checked = !!settings[f.key];
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(' ' + f.label));
        row.appendChild(lab);
      } else {
        var l = make('label', { for: id }, f.label);
        row.appendChild(l);
        if (f.type === 'select') {
          input = make('select', { id: id });
          f.options.forEach(function (o) {
            var opt = make('option', { value: o.value }, o.label);
            if (settings[f.key] === o.value) opt.selected = true;
            input.appendChild(opt);
          });
        } else {
          input = make('input', { type: 'number', id: id, min: f.min, max: f.max, step: f.step || 1, inputmode: 'numeric' });
          input.value = settings[f.key];
        }
      }
      row.appendChild(input);
      if (f.help) row.appendChild(make('div', { class: 'setting-help' }, f.help));

      input.addEventListener('change', function () {
        app.settingsTouched[c.topic] = true;
        if (f.type === 'checkbox') settings[f.key] = input.checked;
        else if (f.type === 'select') settings[f.key] = input.value;
        else settings[f.key] = Number(input.value);
        // keep the visible value within range immediately
        if (f.type === 'int') {
          settings[f.key] = Math.max(f.min, Math.min(f.max, settings[f.key]));
          input.value = settings[f.key];
        }
        refreshValidation();
      });
      host.appendChild(row);
    });
  }

  function renderWeights() {
    var c = app.config;
    var host = $('weightList');
    clear(host);
    if (c.topic !== 'mixed') return;

    c.topics.forEach(function (t, i) {
      var topic = G.getTopic(t.id);
      var row = make('div', { class: 'weight-row' });
      row.appendChild(make('span', { class: 'weight-name' }, topic ? topic.label : t.id));

      var num = make('input', { type: 'number', min: 0, max: 100, step: 1, inputmode: 'numeric', 'aria-label': 'Weight for ' + (topic ? topic.label : t.id) });
      num.value = t.weight;
      num.addEventListener('change', function () {
        var v = Math.max(0, Math.min(100, Number(num.value) || 0));
        num.value = v; c.topics[i].weight = v; refreshValidation();
      });
      row.appendChild(num);

      row.appendChild(make('button', {
        type: 'button', class: 'btn btn-ghost', 'aria-label': 'Remove ' + (topic ? topic.label : t.id),
        onclick: function () { c.topics.splice(i, 1); renderWeights(); refreshValidation(); }
      }, 'Remove'));
      host.appendChild(row);
    });

    if (!c.topics.length) host.appendChild(make('p', { class: 'muted small' }, 'No topics selected yet.'));

    // add-topic select
    var add = $('addWeightTopic');
    clear(add);
    add.appendChild(make('option', { value: '' }, 'Choose a topic…'));
    G.listTopics().forEach(function (t) {
      if (c.topics.some(function (x) { return x.id === t.id; })) return;
      add.appendChild(make('option', { value: t.id }, t.label));
    });
  }

  function refreshValidation() {
    var c = app.config;
    var res = D.validateConfig(c);
    var errs = $('configErrors');
    clear(errs);
    if (res.errors.length) {
      res.errors.forEach(function (e) { errs.appendChild(make('li', null, e)); });
      errs.hidden = false;
    } else {
      errs.hidden = true;
    }
    $('btnStartDrill').disabled = !res.valid;
    $('configSummary').textContent = describeConfig(c);
  }

  function describeConfig(c) {
    var topicName = c.topic === 'mixed'
      ? 'Mixed practice (' + c.topics.filter(function (t) { return t.weight > 0; }).length + ' topics)'
      : (G.getTopic(c.topic) ? G.getTopic(c.topic).label : c.topic);
    var when;
    if (c.sessionType === 'fixed') when = c.questionCount + ' questions';
    else if (c.sessionType === 'countdown') when = (Math.round((c.durationMs / 60000) * 10) / 10) + ' minute countdown';
    else if (c.sessionType === 'stopwatch') when = 'stopwatch — stop whenever you like';
    else if (c.sessionType === 'endless') when = 'endless — stop whenever you like';
    else when = 'untimed — no session clock';
    var extra = [];
    extra.push(DIFF_LABEL[c.difficulty]);
    extra.push(c.answerMode === 'mcq' ? 'MCQ' : 'typed answers');
    extra.push(c.feedback === 'immediate' ? 'immediate feedback' : 'feedback at the end');
    if (c.negativeMarking) extra.push('negative marking on');
    if (c.adaptive) extra.push('adaptive difficulty');
    return topicName + ' · ' + when + ' · ' + extra.join(' · ') + '.';
  }

  /* ========================================================= PRACTICE == */

  function startSession(config) {
    var res = D.validateConfig(config);
    if (!res.valid) { toast('Fix the highlighted settings first.'); return; }
    app.lastRunConfig = JSON.parse(JSON.stringify(config));
    app.feedbackPending = false;
    app.currentStreak = 0;
    app.bestStreak = 0;
    updateStreakUI();
    app.numpadOpen = false;
    updateNumpadUI();
    app.session = D.createSession(config);
    app.session.start();
    showScreen('practice');
    renderQuestion();
    startTicking();
  }

  function updateStreakUI() {
    var wrap = $('pStreakWrap');
    var badge = $('pStreak');
    if (!wrap || !badge) return;
    if (app.currentStreak >= 2) {
      wrap.hidden = false;
      badge.textContent = '🔥 ' + app.currentStreak;
      badge.classList.remove('streak-pop');
      void badge.offsetWidth;
      badge.classList.add('streak-pop');
    } else {
      wrap.hidden = true;
    }
  }

  function toggleNumpad() {
    app.numpadOpen = !app.numpadOpen;
    updateNumpadUI();
  }

  function updateNumpadUI() {
    var wrap = $('pNumpadWrap');
    var lbl = $('btnToggleNumpadLabel');
    if (!wrap) return;
    wrap.hidden = !app.numpadOpen;
    if (lbl) lbl.textContent = app.numpadOpen ? 'Hide Pad' : 'Numpad';
  }

  function handleNumpadKey(key) {
    if (app.screen !== 'practice' || !app.session || app.session.getState() !== D.STATES.RUNNING) return;
    if (app.feedbackPending) {
      if (key === 'enter') goNext();
      return;
    }
    var input = $('pInput');
    if (key === 'enter') {
      submitInput();
      return;
    }
    if (key === 'clear') {
      input.value = '';
      app.session.setPendingInput('');
      try { input.focus(); } catch (e) {}
      return;
    }
    if (key === 'backspace') {
      input.value = input.value.slice(0, -1);
      app.session.setPendingInput(input.value);
      try { input.focus(); } catch (e) {}
      return;
    }
    input.value += key;
    app.session.setPendingInput(input.value);
    try { input.focus(); } catch (e) {}
  }

  function answerInputMode(type) {
    switch (type) {
      case 'integer':
      case 'division': return 'numeric';
      case 'decimal':
      case 'percentage': return 'decimal';
      default: return 'text';
    }
  }
  function answerPlaceholder(type) {
    switch (type) {
      case 'integer': return 'Whole number, e.g. 1440';
      case 'decimal': return 'Decimal answer, e.g. 12.5';
      case 'percentage': return 'Percentage, e.g. 12.5 or 12.5%';
      case 'fraction': return 'Fraction, e.g. 3/4';
      case 'division': return 'Quotient and remainder, e.g. 17 R 3';
      default: return 'Your answer';
    }
  }

  function renderQuestion() {
    var s = app.session;
    var q = s.currentQuestion();
    if (!q) return;
    var cfg = s.getConfig();

    app.feedbackPending = false;
    hideFeedback();
    $('btnNext').hidden = true;

    // header
    var prog = s.getProgress();
    $('pQuestionNo').textContent = prog.total ? (prog.index + ' / ' + prog.total) : String(prog.index);
    $('pTopicChip').textContent = G.getTopic(q.topic) ? G.getTopic(q.topic).label : q.topic;
    $('pDifficulty').textContent = DIFF_LABEL[s.getCurrentDifficulty()] || '—';
    $('pDiffWrap').hidden = !cfg.adaptive;
    updateScoreDisplay();
    updateStreakUI();

    // clock label
    var clockItem = $('pClock').parentNode;
    clockItem.hidden = cfg.sessionType === 'untimed';
    $('pClockLabel').textContent = cfg.sessionType === 'countdown' ? 'Remaining' : 'Elapsed';

    // progress bar
    if (cfg.sessionType === 'fixed' || cfg.sessionType === 'countdown') {
      $('pProgressWrap').hidden = false;
    } else {
      $('pProgressWrap').hidden = true;
    }

    // prompt
    $('pPrompt').textContent = q.prompt;

    // answer area
    if (cfg.answerMode === 'mcq') {
      $('pInputWrap').hidden = true;
      $('pMcq').hidden = false;
      $('pNumpadWrap').hidden = true;
      $('btnToggleNumpad').hidden = true;
      renderMcq(q);
    } else {
      $('pInputWrap').hidden = false;
      $('pMcq').hidden = true;
      $('btnToggleNumpad').hidden = false;
      $('pNumpadWrap').hidden = !app.numpadOpen;
      var input = $('pInput');
      input.value = '';
      input.disabled = false;
      input.setAttribute('inputmode', answerInputMode(q.answerType));
      input.setAttribute('placeholder', answerPlaceholder(q.answerType));
      try { input.focus(); } catch (e) { /* ignore */ }
    }
    app.session.setPendingInput('');
    $('btnSubmit').disabled = false;
    $('btnSkip').disabled = false;
    $('pHint').textContent = cfg.answerMode === 'mcq'
      ? 'Press 1–' + cfg.mcqOptionCount + ' to choose · Alt+S skips · P pauses'
      : 'Enter submits · Alt+S skips · P pauses';
    setPausedUI(s.isPaused());
    updateClocks();
  }

  function renderMcq(q) {
    var host = $('pMcq');
    clear(host);
    q.options.forEach(function (opt, i) {
      var b = make('button', {
        type: 'button', class: 'mcq-option', 'data-index': i,
        onclick: function () { submitMcq(i); }
      });
      b.appendChild(make('span', { class: 'opt-key' }, String(i + 1)));
      b.appendChild(make('span', null, opt.text));
      host.appendChild(b);
    });
  }

  function updateScoreDisplay() {
    var s = app.session; if (!s) return;
    var cfg = s.getConfig();
    var p = s.getProgress();
    var score = p.runningCorrect - (cfg.negativeMarking ? p.runningIncorrect * cfg.negativeFraction : 0);
    $('pScore').textContent = (Math.round(score * 100) / 100);
  }

  function hideFeedback() { $('pFeedback').hidden = true; $('pFeedback').className = 'feedback'; }

  function showFeedback(kind, html) {
    var f = $('pFeedback');
    f.className = 'feedback ' + kind;
    f.innerHTML = html;
    f.hidden = false;
  }

  function lockAnswerArea() {
    $('btnSubmit').disabled = true;
    $('btnSkip').disabled = true;
    $('pInput').disabled = true;
    Array.prototype.forEach.call($('pMcq').querySelectorAll('button'), function (b) { b.disabled = true; });
  }

  function submitInput() {
    if (app.screen !== 'practice' || !app.session || app.session.getState() !== D.STATES.RUNNING) return;
    if (app.feedbackPending) { goNext(); return; }        // Enter advances after immediate feedback
    var value = $('pInput').value;
    var res = app.session.submit(value);
    if (!res.ok) {
      if (res.status === 'invalid') { toast(res.reason || 'Check your answer.'); try { $('pInput').focus(); } catch (e) {} }
      return;
    }
    afterFinalise(res);
  }

  function submitMcq(index) {
    if (app.screen !== 'practice' || !app.session || app.session.getState() !== D.STATES.RUNNING) return;
    if (app.feedbackPending) return;
    var res = app.session.submit(index);
    if (!res.ok) return;
    afterFinalise(res, index);
  }

  function afterFinalise(res, mcqIndex) {
    if (res.status === 'correct') {
      app.currentStreak = (app.currentStreak || 0) + 1;
      if (app.currentStreak > (app.bestStreak || 0)) app.bestStreak = app.currentStreak;
    } else {
      app.currentStreak = 0;
    }
    updateStreakUI();

    var cfg = app.session.getConfig();
    if (cfg.feedback === 'immediate') {
      app.feedbackPending = true;
      lockAnswerArea();
      if (cfg.answerMode === 'mcq') markMcqResult(mcqIndex);
      var ok = res.status === 'correct';
      var body = ok
        ? '<div>Correct.</div>'
        : '<div>Incorrect. <span class="fb-answer">Correct answer: ' + escapeHtml(res.correctText) + '</span></div>';
      showFeedback(ok ? 'ok' : 'bad', body);
      $('btnNext').hidden = false;
      try { $('btnNext').focus(); } catch (e) {}
      if (cfg.autoAdvance) {
        if (app.autoHandle) clearTimeout(app.autoHandle);
        app.autoHandle = setTimeout(function () { goNext(); }, cfg.autoAdvanceMs);
      }
      updateScoreDisplay();
    } else {
      updateScoreDisplay();
      goNext();
    }
  }

  function markMcqResult(index) {
    var q = app.session.currentQuestion();
    Array.prototype.forEach.call($('pMcq').querySelectorAll('button'), function (b) {
      var i = Number(b.getAttribute('data-index'));
      b.disabled = true;
      if (q.options[i].correct) b.classList.add('is-correct');
      else if (i === index) b.classList.add('is-wrong');
    });
  }

  function goNext() {
    if (app.autoHandle) { clearTimeout(app.autoHandle); app.autoHandle = null; }
    var r = app.session.next();
    if (r.done) { finishDrill(); return; }
    renderQuestion();
  }

  function skipQuestion() {
    if (app.screen !== 'practice' || !app.session) return;
    if (app.feedbackPending) return;
    var res = app.session.skip();
    if (!res.ok) return;
    app.currentStreak = 0;
    updateStreakUI();

    var cfg = app.session.getConfig();
    if (cfg.feedback === 'immediate') {
      app.feedbackPending = true;
      lockAnswerArea();
      var q = app.session.currentQuestion();
      showFeedback('info', '<div>Skipped. <span class="fb-answer">Correct answer: ' + escapeHtml(G.answerText(q.answer)) + '</span></div>');
      $('btnNext').hidden = false;
      try { $('btnNext').focus(); } catch (e) {}
      if (cfg.autoAdvance) {
        if (app.autoHandle) clearTimeout(app.autoHandle);
        app.autoHandle = setTimeout(function () { goNext(); }, cfg.autoAdvanceMs);
      }
      updateScoreDisplay();
    } else {
      goNext();
    }
  }

  function togglePause() {
    if (!app.session) return;
    var st = app.session.getState();
    if (st === D.STATES.RUNNING) {
      app.session.pause();
      setPausedUI(true);
      openPauseModal();
    } else if (st === D.STATES.PAUSED) {
      resumeSession();
    }
  }

  function resumeSession() {
    closeModal();
    if (!app.session) return;
    app.session.resume();
    setPausedUI(false);
    if (app.session.getConfig().answerMode === 'input') { try { $('pInput').focus(); } catch (e) {} }
  }

  function setPausedUI(paused) {
    $('btnPause').setAttribute('aria-pressed', String(paused));
    var lbl = $('btnPauseLabel');
    if (lbl) lbl.textContent = paused ? 'Resume' : 'Pause';
    var ic = $('btnPauseIcon');
    if (ic) ic.setAttribute('href', paused ? '#i-play' : '#i-pause');
  }

  function openPauseModal() {
    openModal({
      title: 'Paused',
      body: 'The session and question timers are frozen. Paused time is never counted.',
      actions: [
        { label: 'Resume', class: 'btn-primary', onClick: resumeSession },
        { label: 'End drill', class: 'btn-danger-ghost', onClick: function () { endDrill(); } }
      ],
      onClose: function () {
        // closing by Esc also resumes, so the user is never stuck paused
        if (app.session && app.session.getState() === D.STATES.PAUSED) resumeSession();
      }
    });
  }

  function confirmEnd() {
    if (!app.session) return;
    var wasPaused = app.session.getState() === D.STATES.PAUSED;
    if (!wasPaused) app.session.pause();
    openModal({
      title: 'End this drill?',
      body: 'You will get a full report for the questions shown so far. The current question is recorded as skipped.',
      actions: [
        { label: 'Keep practising', class: 'btn-outline', onClick: function () { if (!wasPaused) resumeSession(); } },
        { label: 'End drill', class: 'btn-danger-ghost', onClick: function () { app.session.resume(); endDrill(); } }
      ],
      onClose: function () { if (!wasPaused && app.session.getState() === D.STATES.PAUSED) resumeSession(); }
    });
  }

  function endDrill() {
    if (!app.session) return;
    app.autoHandle && clearTimeout(app.autoHandle);
    app.session.end();
    finishDrill();
  }

  /* -------------------------------------------------------------- ticking */

  function startTicking() {
    stopTicking();
    app.tickHandle = setInterval(function () {
      if (!app.session || app.screen !== 'practice') return;
      updateClocks();
      var partial = app.session.getConfig().answerMode === 'input' ? $('pInput').value : '';
      var r = app.session.tick(partial);
      if (r.questionTimedOut) {
        app.currentStreak = 0;
        updateStreakUI();
        var cfg = app.session.getConfig();
        if (cfg.feedback === 'immediate') {
          app.feedbackPending = true;
          lockAnswerArea();
          var q = app.session.currentQuestion();
          showFeedback('bad', '<div>Time&rsquo;s up for this question. <span class="fb-answer">Correct answer: ' + escapeHtml(G.answerText(q.answer)) + '</span></div>');
          $('btnNext').hidden = false;
        } else {
          goNext();
        }
        updateScoreDisplay();
      }
      if (r.expired) { finishDrill(); }
    }, 200);
  }
  function stopTicking() { if (app.tickHandle) { clearInterval(app.tickHandle); app.tickHandle = null; } }

  function updateClocks() {
    var s = app.session; if (!s) return;
    var rem = s.remainingMs();
    if (rem == null) $('pClock').textContent = T.formatDuration(s.elapsedMs());
    else $('pClock').textContent = T.formatDuration(rem);
    $('pQTimer').textContent = T.formatResponseTime(s.currentQuestionElapsedMs());

    var cfg = s.getConfig();
    var fill = $('pProgressFill');
    var wrap = $('pProgressWrap');
    if (cfg.sessionType === 'fixed') {
      var p = s.getProgress();
      var pct = p.total ? Math.min(100, (p.answeredRecords / p.total) * 100) : 0;
      fill.style.width = pct + '%';
      wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    } else if (cfg.sessionType === 'countdown') {
      var pct2 = cfg.durationMs ? Math.min(100, (s.elapsedMs() / cfg.durationMs) * 100) : 0;
      fill.style.width = pct2 + '%';
      wrap.setAttribute('aria-valuenow', String(Math.round(pct2)));
    }
  }

  function finishDrill() {
    stopTicking();
    app.results = app.session.getResults();
    app.records = app.session.getRecords();
    app.reviewFilter = 'all';
    renderResults();
    showScreen('results');
  }

  /* ========================================================== RESULTS == */

  function metricCard(label, value, note, cls) {
    var c = make('div', { class: 'metric' + (cls ? ' ' + cls : '') });
    var ic = METRIC_ICON[label];
    c.appendChild(make('div', { class: 'm-label', html: (ic ? icon(ic) : '') + '<span>' + label + '</span>' }));
    c.appendChild(make('div', { class: 'm-value' }, value));
    if (note) c.appendChild(make('div', { class: 'm-note' }, note));
    return c;
  }

  function renderResults() {
    var r = app.results;
    var cfg = app.session ? app.session.getConfig() : (app.lastRunConfig || {});
    var grid = $('metricsGrid');
    clear(grid);

    var note = $('resultsNote');
    if (!r.hasData) {
      note.hidden = false;
      note.textContent = 'No questions were presented in this drill, so there are no statistics to show.';
    } else if (!r.hasAnswered) {
      note.hidden = false;
      note.textContent = 'You did not answer any questions, so accuracy and response-time figures are unavailable. Correct answers are still shown below.';
    } else {
      note.hidden = true;
    }

    $('resultsSubtitle').textContent = describeResultContext(cfg, r);

    grid.appendChild(metricCard('Questions shown', String(r.presented), null));
    grid.appendChild(metricCard('Answered', String(r.answered), null));
    grid.appendChild(metricCard('Correct', String(r.correct), null, r.correct > 0 ? 'good' : ''));
    grid.appendChild(metricCard('Incorrect', String(r.incorrect), null, r.incorrect > 0 ? 'bad' : ''));
    grid.appendChild(metricCard('Skipped', String(r.skipped)));
    grid.appendChild(metricCard('Timed out', String(r.timedOut)));
    grid.appendChild(metricCard('Accuracy',
      r.accuracy == null ? '—' : r.accuracy + '%', 'correct ÷ answered', ''));
    grid.appendChild(metricCard('Correct of shown',
      r.correctOfPresented == null ? '—' : r.correctOfPresented + '%', 'correct ÷ presented'));
    grid.appendChild(metricCard('Average response',
      r.avgResponseMs == null ? '—' : T.formatResponseTime(r.avgResponseMs), 'answered questions only'));
    grid.appendChild(metricCard('Total time', T.formatDuration(r.totalMs)));
    grid.appendChild(metricCard('Questions / min',
      r.attemptsPerMin == null ? '—' : String(r.attemptsPerMin), 'attempted per minute'));
    grid.appendChild(metricCard('Correct / min',
      r.correctPerMin == null ? '—' : String(r.correctPerMin)));
    if (app.bestStreak > 1) {
      grid.appendChild(metricCard('Best streak', app.bestStreak + ' in a row', 'consecutive correct', 'good'));
    }
    if (r.negativeMarking) {
      grid.appendChild(metricCard('Score', String(Math.round(r.score * 100) / 100),
        '−' + r.negativeFraction + ' per wrong', r.score >= 0 ? 'good' : 'bad'));
    }

    // topic-wise
    var tw = $('cardTopicWise');
    var body = $('topicWiseBody');
    clear(body);
    if (r.topicWise.length > 1) {
      tw.hidden = false;
      r.topicWise.forEach(function (t) {
        var tr = make('tr');
        tr.appendChild(make('td', null, G.getTopic(t.topic) ? G.getTopic(t.topic).label : t.topic));
        tr.appendChild(make('td', null, String(t.presented)));
        tr.appendChild(make('td', null, String(t.answered)));
        tr.appendChild(make('td', null, String(t.correct)));
        tr.appendChild(make('td', null, String(t.incorrect)));
        tr.appendChild(make('td', null, String(t.skipped)));
        tr.appendChild(make('td', null, String(t.timedOut)));
        tr.appendChild(make('td', null, t.accuracy == null ? '—' : t.accuracy + '%'));
        tr.appendChild(make('td', null, t.avgResponseMs == null ? '—' : T.formatResponseTime(t.avgResponseMs)));
        body.appendChild(tr);
      });
    } else {
      tw.hidden = true;
    }

    // weakness
    var slow = $('slowList'), errs = $('errorList');
    clear(slow); clear(errs);
    var showWeak = r.slowest.length > 0 || r.errorTopics.length > 0;
    $('cardWeakness').hidden = !showWeak;
    if (!r.slowest.length) slow.appendChild(make('li', { class: 'muted' }, 'No timed questions.'));
    r.slowest.forEach(function (s) {
      var li = make('li');
      li.appendChild(make('span', null, 'Q' + s.index + ': ' + s.prompt));
      li.appendChild(make('strong', null, T.formatResponseTime(s.responseMs)));
      slow.appendChild(li);
    });
    if (!r.errorTopics.length) errs.appendChild(make('li', { class: 'muted' }, 'No incorrect, skipped or timed-out questions.'));
    r.errorTopics.forEach(function (e) {
      var li = make('li');
      li.appendChild(make('span', null, G.getTopic(e.topic) ? G.getTopic(e.topic).label : e.topic));
      li.appendChild(make('strong', null, e.errors + ' error' + (e.errors === 1 ? '' : 's')));
      errs.appendChild(li);
    });

    // review filters
    Array.prototype.forEach.call($('reviewFilters').querySelectorAll('button'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-filter') === app.reviewFilter);
    });
    renderReview();

    // actions availability
    $('btnPractiseWrong').disabled = AN.mistakeRecords(app.records).length === 0;
  }

  function describeResultContext(cfg, r) {
    var bits = [];
    var topicName = cfg.topic === 'mixed' ? 'Mixed practice'
      : (G.getTopic(cfg.topic) ? G.getTopic(cfg.topic).label : cfg.topic);
    bits.push(topicName);
    bits.push(DIFF_LABEL[cfg.difficulty] || '');
    bits.push(cfg.answerMode === 'mcq' ? 'MCQ' : 'Typed answers');
    bits.push(cfg.feedback === 'immediate' ? 'Immediate feedback' : 'Feedback at the end');
    if (r.negativeMarking) bits.push('Negative marking on');
    return bits.filter(Boolean).join(' · ');
  }

  function renderReview() {
    var list = $('reviewList');
    clear(list);
    var filtered = AN.filterRecords(app.records, app.reviewFilter, app.results ? app.results.slowThresholdMs : null);
    if (!filtered.length) {
      list.appendChild(make('li', { class: 'empty' }, 'Nothing matches this filter.'));
      return;
    }
    filtered.forEach(function (rec) {
      list.appendChild(reviewItem(rec));
    });
  }

  function reviewItem(rec) {
    var li = make('li', { class: 'review-item ' + (rec.status || '') });
    var top = make('div', { class: 'review-top' });
    top.appendChild(make('div', { class: 'review-q' }, 'Q' + rec.index + '. ' + rec.prompt));

    var badges = make('div', { class: 'review-badges' });
    var bmap = { correct: ['Correct', 'ok'], incorrect: ['Incorrect', 'bad'], skipped: ['Skipped', 'warn'], timedout: ['Timed out', 'warn'] };
    var b = bmap[rec.status] || ['—', ''];
    badges.appendChild(make('span', { class: 'badge ' + b[1] }, b[0]));
    badges.appendChild(make('span', { class: 'badge' }, T.formatResponseTime(rec.responseMs)));
    badges.appendChild(make('span', { class: 'badge' }, G.getTopic(rec.topic) ? G.getTopic(rec.topic).label : rec.topic));
    if (rec.isRetry) badges.appendChild(make('span', { class: 'badge' }, 'retry'));
    top.appendChild(badges);
    li.appendChild(top);

    var detail = make('div', { class: 'review-detail' });
    detail.appendChild(kv('Your answer', rec.submittedText && rec.submittedText.length ? rec.submittedText : '—'));
    detail.appendChild(kv('Correct answer', rec.correctText));
    li.appendChild(detail);

    var expl = make('div', { class: 'review-expl' });
    if (rec.explanation) {
      expl.appendChild(make('strong', null, 'Shortcut: '));
      expl.appendChild(document.createTextNode(rec.explanation));
    } else {
      expl.appendChild(document.createTextNode('Correct answer verified; no shortcut template for this pattern.'));
    }
    li.appendChild(expl);
    return li;
  }

  function kv(label, value) {
    var d = make('div', { class: 'kv' });
    d.appendChild(make('span', null, label));
    d.appendChild(make('span', null, value));
    return d;
  }

  /* ======================================================= unload guard == */

  function updateUnloadGuard() {
    var active = app.session && (app.session.getState() === D.STATES.RUNNING || app.session.getState() === D.STATES.PAUSED);
    if (active && app.screen === 'practice') {
      window.onbeforeunload = function () { return 'Your current drill will be lost.'; };
    } else {
      window.onbeforeunload = null;
    }
  }

  /* ============================================================= wiring == */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function wire() {
    // dashboard
    $('btnQuickStart').addEventListener('click', function () {
      if (!app.config) app.config = freshConfig();
      app.config.topic = 'mixed';
      startConfig('mixed');
    });
    $('btnQuickConfig').addEventListener('click', function () { startConfig(app.config ? app.config.topic : 'mixed'); });

    // config
    $('btnBackDash').addEventListener('click', function () { showScreen('dashboard'); });
    $('cfgTopic').addEventListener('change', function () {
      app.config.topic = $('cfgTopic').value;
      if (app.config.topic !== 'mixed' && !app.config.topicSettings[app.config.topic]) {
        app.config.topicSettings[app.config.topic] = G.defaultSettings(app.config.topic, app.config.difficulty);
      }
      toggleConditionalFields(); renderTopicSettings(); renderWeights(); refreshValidation();
    });
    Array.prototype.forEach.call($('cfgDifficulty').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var d = b.getAttribute('data-diff');
        app.config.difficulty = d;
        renderDifficulty();
        // adopt the difficulty preset unless the user has customised this topic
        if (app.config.topic !== 'mixed' && !app.settingsTouched[app.config.topic]) {
          app.config.topicSettings[app.config.topic] = G.defaultSettings(app.config.topic, d);
        }
        renderTopicSettings(); refreshValidation();
      });
    });
    $('cfgSessionType').addEventListener('change', function () {
      app.config.sessionType = $('cfgSessionType').value; toggleConditionalFields(); refreshValidation();
    });
    $('cfgCount').addEventListener('input', function () {
      app.config.questionCount = Math.round(Number($('cfgCount').value)); refreshValidation();
    });
    $('cfgMinutes').addEventListener('input', function () {
      app.config.durationMs = Math.round(Number($('cfgMinutes').value) * 60000); refreshValidation();
    });
    $('cfgAnswerMode').addEventListener('change', function () {
      app.config.answerMode = $('cfgAnswerMode').value; toggleConditionalFields(); refreshValidation();
    });
    $('cfgMcqCount').addEventListener('input', function () {
      app.config.mcqOptionCount = Math.round(Number($('cfgMcqCount').value)); refreshValidation();
    });
    $('cfgFeedback').addEventListener('change', function () {
      app.config.feedback = $('cfgFeedback').value; toggleConditionalFields(); refreshValidation();
    });
    $('cfgAutoAdvance').addEventListener('change', function () {
      app.config.autoAdvance = $('cfgAutoAdvance').checked; toggleConditionalFields(); refreshValidation();
    });
    $('cfgAutoAdvanceMs').addEventListener('input', function () {
      app.config.autoAdvanceMs = Math.round(Number($('cfgAutoAdvanceMs').value) * 1000); refreshValidation();
    });
    $('cfgNegative').addEventListener('change', function () {
      app.config.negativeMarking = $('cfgNegative').checked; toggleConditionalFields(); refreshValidation();
    });
    $('cfgNegativeFraction').addEventListener('change', function () {
      app.config.negativeFraction = Number($('cfgNegativeFraction').value); refreshValidation();
    });
    $('cfgPerQuestion').addEventListener('change', function () {
      app.config.perQuestionLimitMs = $('cfgPerQuestion').checked ? Math.max(3, Number($('cfgPerQuestionSec').value)) * 1000 : null;
      toggleConditionalFields(); refreshValidation();
    });
    $('cfgPerQuestionSec').addEventListener('input', function () {
      if (app.config.perQuestionLimitMs) app.config.perQuestionLimitMs = Math.max(3, Number($('cfgPerQuestionSec').value)) * 1000;
      refreshValidation();
    });
    $('cfgAdaptive').addEventListener('change', function () {
      app.config.adaptive = $('cfgAdaptive').checked; refreshValidation();
    });
    $('addWeightTopic').addEventListener('change', function () {
      var id = $('addWeightTopic').value;
      if (!id) return;
      app.config.topics.push({ id: id, weight: 10 });
      renderWeights(); refreshValidation();
    });
    $('btnResetConfig').addEventListener('click', function () {
      app.config = freshConfig();
      app.settingsTouched = {};
      renderConfig();
      toast('Configuration reset.');
    });
    $('btnStartDrill').addEventListener('click', function () { startSession(app.config); });

    // practice
    $('btnSubmit').addEventListener('click', submitInput);
    $('btnSkip').addEventListener('click', skipQuestion);
    $('btnNext').addEventListener('click', goNext);
    $('btnPause').addEventListener('click', togglePause);
    $('btnEnd').addEventListener('click', confirmEnd);
    $('pInput').addEventListener('input', function () { app.session && app.session.setPendingInput($('pInput').value); });
    $('pInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitInput(); }
    });

    // results
    Array.prototype.forEach.call($('reviewFilters').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        app.reviewFilter = b.getAttribute('data-filter');
        Array.prototype.forEach.call($('reviewFilters').querySelectorAll('button'), function (x) {
          x.classList.toggle('is-active', x === b);
        });
        renderReview();
      });
    });
    $('btnPractiseWrong').addEventListener('click', function () {
      var retry = D.createRetrySession(app.records, app.lastRunConfig || {});
      if (!retry) { toast('No wrong questions to retry.'); return; }
      app.session = retry;
      app.session.start();
      showScreen('practice');
      renderQuestion();
      startTicking();
    });
    $('btnRetryDrill').addEventListener('click', function () {
      if (!app.lastRunConfig) { showScreen('dashboard'); return; }
      startSession(app.lastRunConfig);
    });
    $('btnSameTopic').addEventListener('click', function () {
      var cfg = app.lastRunConfig || freshConfig();
      if (!app.config) app.config = freshConfig();
      app.config = JSON.parse(JSON.stringify(cfg));
      startConfig(app.config.topic);
    });
    $('btnBackHome').addEventListener('click', function () { showScreen('dashboard'); });
    $('btnCopyScorecard').addEventListener('click', copyScorecard);

    // practice numpad & shortcuts
    $('btnToggleNumpad').addEventListener('click', toggleNumpad);
    Array.prototype.forEach.call($('pNumpad').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        handleNumpadKey(b.getAttribute('data-key'));
      });
    });

    // top bar
    $('btnCheatSheet').addEventListener('click', showCheatSheetModal);
    $('btnHelp').addEventListener('click', showHelpModal);
    $('btnTheme').addEventListener('click', toggleTheme);

    // modal close on backdrop click
    $('modal').addEventListener('mousedown', function (e) {
      if (e.target === $('modal')) closeModal();
    });

    // global keyboard
    document.addEventListener('keydown', globalKeydown);
  }

  function copyScorecard() {
    var r = app.results;
    if (!r) { toast('No results to copy.'); return; }
    var cfg = app.lastRunConfig || (app.session ? app.session.getConfig() : {});
    var topicLabel = cfg.topic === 'mixed' ? 'Mixed Practice' : (G.getTopic(cfg.topic) ? G.getTopic(cfg.topic).label : cfg.topic);
    var diffLabel = DIFF_LABEL[cfg.difficulty] || 'Medium';

    var lines = [
      '⚡ Speed Maths Trainer — Drill Scorecard',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '📚 Topic: ' + topicLabel + ' (' + diffLabel + ')',
      '🎯 Accuracy: ' + (r.accuracy != null ? r.accuracy + '%' : '—') + ' (' + r.correct + ' correct / ' + r.answered + ' answered)',
      '📊 Questions Shown: ' + r.presented + ' (Incorrect: ' + r.incorrect + ', Skipped: ' + r.skipped + ', Timed out: ' + r.timedOut + ')',
      '⏱️ Average Response: ' + (r.avgResponseMs != null ? T.formatResponseTime(r.avgResponseMs) : '—'),
      '⚡ Speed: ' + (r.attemptsPerMin != null ? r.attemptsPerMin + ' Q/min' : '—') + (r.correctPerMin != null ? ' (' + r.correctPerMin + ' correct/min)' : ''),
      '⏳ Total Time: ' + T.formatDuration(r.totalMs),
      app.bestStreak > 1 ? ('🔥 Best Streak: ' + app.bestStreak + ' in a row') : null,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'Speed Maths Trainer — 100% Free & Offline-Ready'
    ].filter(Boolean);

    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Scorecard copied to clipboard!');
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toast('Scorecard copied to clipboard!');
    } catch (e) {
      toast('Could not copy to clipboard.');
    }
    document.body.removeChild(ta);
  }

  function showCheatSheetModal() {
    openModal({
      title: '⚡ Speed Maths Formulas & Cheat Sheet',
      modalClass: 'modal-lg',
      bodyNode: buildCheatSheetNode(),
      actions: [{ label: 'Close', class: 'btn-primary' }]
    });
  }

  function buildCheatSheetNode() {
    var wrap = make('div');

    var tabs = make('div', { class: 'ref-tabs' });
    var btnPowers = make('button', { type: 'button', class: 'ref-tab is-active' }, 'Squares & Cubes');
    var btnFractions = make('button', { type: 'button', class: 'ref-tab' }, 'Fractions ↔ Percentages');
    var btnTricks = make('button', { type: 'button', class: 'ref-tab' }, 'Vedic & Shortcut Tricks');
    tabs.appendChild(btnPowers);
    tabs.appendChild(btnFractions);
    tabs.appendChild(btnTricks);
    wrap.appendChild(tabs);

    // Panel 1: Squares (1-50) & Cubes (1-30)
    var p1 = make('div', { class: 'ref-panel' });
    p1.appendChild(make('h3', null, 'Squares (1 to 50)'));
    var sqGrid = make('div', { class: 'ref-grid mb-sm' });
    for (var i = 1; i <= 50; i++) {
      var cell = make('div', { class: 'ref-cell' });
      cell.innerHTML = '<span>' + i + '²</span><strong>' + (i * i) + '</strong>';
      sqGrid.appendChild(cell);
    }
    p1.appendChild(sqGrid);

    p1.appendChild(make('h3', null, 'Cubes (1 to 30)'));
    var cuGrid = make('div', { class: 'ref-grid' });
    for (var j = 1; j <= 30; j++) {
      var cCell = make('div', { class: 'ref-cell' });
      cCell.innerHTML = '<span>' + j + '³</span><strong>' + (j * j * j) + '</strong>';
      cuGrid.appendChild(cCell);
    }
    p1.appendChild(cuGrid);
    wrap.appendChild(p1);

    // Panel 2: Fractions ↔ Percentages
    var p2 = make('div', { class: 'ref-panel', hidden: true });
    p2.appendChild(make('p', { class: 'muted small mb-sm' }, 'Standard bank-exam percentage equivalents. Memorizing these fraction pairs saves 10–15 seconds per simplification question.'));
    var tbl = make('table', { class: 'ref-table' });
    tbl.innerHTML = '<thead><tr><th>Fraction</th><th>Decimal Value</th><th>Percentage Equivalent</th></tr></thead>';
    var tb = make('tbody');
    var fRows = [
      ['1/2', '0.5', '50%'],
      ['1/3', '0.3333...', '33.33% (or 33⅓%)'],
      ['2/3', '0.6667...', '66.67% (or 66⅔%)'],
      ['1/4', '0.25', '25%'],
      ['3/4', '0.75', '75%'],
      ['1/5', '0.2', '20%'],
      ['2/5', '0.4', '40%'],
      ['3/5', '0.6', '60%'],
      ['4/5', '0.8', '80%'],
      ['1/6', '0.1667...', '16.67% (or 16⅔%)'],
      ['1/7', '0.1428...', '14.28% (or 14²/₇%)'],
      ['1/8', '0.125', '12.5% (or 12½%)'],
      ['3/8', '0.375', '37.5%'],
      ['5/8', '0.625', '62.5%'],
      ['7/8', '0.875', '87.5%'],
      ['1/9', '0.1111...', '11.11% (or 11¹/₉%)'],
      ['1/10', '0.1', '10%'],
      ['1/11', '0.0909...', '9.09% (or 9¹/₁₁%)'],
      ['1/12', '0.0833...', '8.33% (or 8⅓%)'],
      ['1/14', '0.0714...', '7.14% (or 7¹/₇%)'],
      ['1/15', '0.0667...', '6.67% (or 6⅔%)'],
      ['1/16', '0.0625', '6.25% (or 6¼%)'],
      ['1/20', '0.05', '5%'],
      ['1/25', '0.04', '4%']
    ];
    fRows.forEach(function (r) {
      var tr = make('tr');
      tr.innerHTML = '<td><strong>' + r[0] + '</strong></td><td>' + r[1] + '</td><td>' + r[2] + '</td>';
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    p2.appendChild(tbl);
    wrap.appendChild(p2);

    // Panel 3: Vedic & Exam Shortcuts
    var p3 = make('div', { class: 'ref-panel', hidden: true });
    var tricks = [
      {
        title: 'Squaring numbers ending in 5',
        desc: 'Multiply the tens digit by (tens digit + 1), then append 25.',
        eg: '65² → (6 × 7) | 25 = 4225  ·  95² → (9 × 10) | 25 = 9025'
      },
      {
        title: 'Multiplication by 5, 25, 50, 125',
        desc: 'Divide by 2, 4, 2, or 8 and shift decimal points.',
        eg: 'N × 5 = (N ÷ 2) × 10  ·  N × 25 = (N ÷ 4) × 100  ·  N × 125 = (N ÷ 8) × 1000'
      },
      {
        title: 'Multiplication near 100 (Vedic Base Method)',
        desc: 'For numbers near 100, subtract cross deviation and multiply deficiencies.',
        eg: '96 × 97: Deficits are −4 and −3. Left: 96 − 3 = 93. Right: (−4) × (−3) = 12 → 9312.'
      },
      {
        title: 'Squaring numbers near 50',
        desc: 'Use base 25: for (50 + d)², result is (25 + d) | d².',
        eg: '54²: d = +4 → (25 + 4) | 4² = 2916  ·  47²: d = −3 → (25 − 3) | 3² = 2209'
      },
      {
        title: 'Multiplication by 11',
        desc: 'Sandwich digits and add adjacent pairs.',
        eg: '52 × 11 = 5 [5+2] 2 = 572  ·  78 × 11 = 7 [7+8=15] 8 → (7+1) 5 8 = 858'
      },
      {
        title: 'BODMAS Rule Order',
        desc: 'Brackets () → Orders (x², √x) → Division ÷ → Multiplication × → Addition + → Subtraction −.',
        eg: 'Always calculate Division & Multiplication left-to-right before Addition & Subtraction!'
      }
    ];
    tricks.forEach(function (t) {
      var tc = make('div', { class: 'trick-card' });
      tc.appendChild(make('h3', null, '💡 ' + t.title));
      tc.appendChild(make('p', null, t.desc));
      tc.appendChild(make('p', { html: '<code>' + t.eg + '</code>' }));
      p3.appendChild(tc);
    });
    wrap.appendChild(p3);

    function setTab(idx) {
      btnPowers.classList.toggle('is-active', idx === 0);
      btnFractions.classList.toggle('is-active', idx === 1);
      btnTricks.classList.toggle('is-active', idx === 2);
      p1.hidden = idx !== 0;
      p2.hidden = idx !== 1;
      p3.hidden = idx !== 2;
    }
    btnPowers.onclick = function () { setTab(0); };
    btnFractions.onclick = function () { setTab(1); };
    btnTricks.onclick = function () { setTab(2); };

    return wrap;
  }

  function globalKeydown(e) {
    // Escape always closes an open modal
    if (e.key === 'Escape') {
      if (!$('modal').hidden) { closeModal(); return; }
      if (app.screen === 'practice') { e.preventDefault(); confirmEnd(); }
      return;
    }
    if (!$('modal').hidden) return;                    // don't act behind a dialog

    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (app.screen !== 'practice') return;

    // skip: Alt+S or Ctrl+ArrowRight
    if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && e.key === 'ArrowRight')) {
      e.preventDefault(); skipQuestion(); return;
    }
    if (e.key === 'p' || e.key === 'P') {
      if (typing && t.id === 'pInput') {
        // allow typing "p" only when the answer could contain a letter; otherwise treat as pause
        var q = app.session && app.session.currentQuestion();
        if (q && q.answerType === 'fraction') return;
      }
      e.preventDefault(); togglePause(); return;
    }
    // MCQ number keys
    if (!typing && /^[1-6]$/.test(e.key)) {
      var q2 = app.session && app.session.currentQuestion();
      if (q2 && app.session.getConfig().answerMode === 'mcq' && !app.feedbackPending) {
        var idx = Number(e.key) - 1;
        if (idx < q2.options.length) { e.preventDefault(); submitMcq(idx); }
      }
    }
  }

  function showHelpModal() {
    openModal({
      title: 'Keyboard shortcuts',
      bodyNode: helpNode(),
      actions: [{ label: 'Close', class: 'btn-primary' }]
    });
  }

  function helpNode() {
    var wrap = make('div');
    var dl = make('dl', { class: 'keys' });
    var rows = [
      ['Enter', 'Submit the current answer (and advance after immediate feedback)'],
      ['Alt+S or Ctrl+→', 'Skip the current question'],
      ['1 – 6', 'Choose an MCQ option'],
      ['P', 'Pause / resume'],
      ['Esc', 'Pause menu and exit options']
    ];
    rows.forEach(function (r) {
      dl.appendChild(make('dt', null, r[0]));
      dl.appendChild(make('dd', null, r[1]));
    });
    wrap.appendChild(dl);
    return wrap;
  }

  function toggleTheme() {
    var root = document.documentElement;
    var current = root.getAttribute('data-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var effective = current || (prefersDark ? 'dark' : 'light');
    var next = effective === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    $('btnTheme').setAttribute('aria-pressed', String(next === 'dark'));
    toast('Switched to ' + next + ' theme.');
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    if (!V || !G || !T || !AN || !D) {
      document.body.innerHTML = '<p style="padding:2rem;font:16px system-ui">' +
        'The application scripts did not load. If you opened this file directly, make sure the ' +
        '<code>js/</code> folder sits next to <code>index.html</code>. See README.md for details.</p>';
      return;
    }
    app.config = freshConfig();
    renderPresetGrid();
    renderTopicGrid();
    wire();
    showScreen('dashboard');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
