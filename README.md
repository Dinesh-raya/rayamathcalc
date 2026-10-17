# Speed Maths Trainer — bank exam practice

A free, offline-friendly **speed maths trainer** for Indian banking and
government competitive exams (IBPS, SBI, RRB, SSC and similar). It generates
unlimited practice questions across 17 topics, times each drill, scores your
answers, and shows an honest analysis of where you lost speed or accuracy.

It is a **static site**: plain HTML5, CSS3 and vanilla JavaScript. No build
step, no framework, no backend, no database, no accounts, no tracking, no
external requests, and no browser storage.

---

## What it does

- **17 question generators** — addition, subtraction, multiplication, division,
  multiplication tables, squares, cubes, square roots, cube roots, powers,
  percentages, fraction → percent, percent → fraction, fraction arithmetic,
  BODMAS, mixed arithmetic, and number patterns.
- **Difficulty changes the pattern, not just the numbers.** Easy/medium/hard
  select genuinely different question shapes (e.g. hard squares use the
  near-50 shortcut pattern; hard BODMAS builds deeper token expressions).
- **Five session types** — fixed number of questions, countdown, stopwatch,
  endless, and untimed.
- **Answer entry or multiple choice.** MCQ options are plausible near-misses
  (digit transposition, ± one unit, and so on), never random noise.
- **Keyboard-first practice** — `Enter` submits, `Alt+S` (or `Ctrl+→`) skips,
  `P` pauses, `1`–`6` pick MCQ options, `Esc` opens the pause/exit menu.
  Tab is never hijacked.
- **A verified correct answer for every question** — including wrong, skipped
  and timed-out ones. The correct answer is authored when the question is built
  and re-checked before display; it is never derived from what you typed.
- **A real report** — questions shown, answered, correct, incorrect, skipped and
  timed out; accuracy (correct ÷ answered) *and* correct-of-shown
  (correct ÷ presented); average response time (answered questions only); total
  time; questions/min; correct/min; optional negative marking (off by default);
  topic-wise breakdown for mixed drills; slowest questions and most-error
  topics; and review filters (all / incorrect / skipped / timed out / slow).
- **Practice again** — retry only your mistakes, retry the same topic with fresh
  questions, or run the whole drill again.

### Deliberately *not* included

- No login, accounts, profiles or history.
- No `localStorage`, `sessionStorage`, cookies or IndexedDB. The current drill
  and its analysis live **in memory only**, so refreshing or closing the page
  intentionally discards them.
- No analytics, trackers, external fonts, external images or data transmission.

---

## Requirements

A modern browser (Chrome, Edge, Firefox or Safari) and — only for running the
tests — [Node.js](https://nodejs.org/) 18 or newer. There is **no** `npm install`
and **no** build step.

---

## Running it locally

Because everything is static and self-contained, you have two options.

### 1. Open the file directly

Double-click `index.html`, or drag it into a browser window. This works because
the site loads its scripts with plain `<script src="...">` tags (no ES modules,
no `fetch`), so no web server is required. The `js/` and `css/` folders must
stay next to `index.html`.

### 2. Serve the folder (recommended)

Some browsers apply stricter rules to `file://` pages. Serving over HTTP avoids
that entirely. Any static server works, for example:

```bash
# Python 3 (already installed on most systems)
python -m http.server 8080
```

```bash
# Node.js, without installing anything globally
npx --yes serve .
```

Then open <http://localhost:8080/>.

---

## Testing

The pure engine modules (`generators`, `validation`, `timer`, `analytics`,
`drills`) are written so they load both as browser globals and as CommonJS
modules. A single set of shared cases in `tests/cases.js` drives two runners.

### Node runner

```bash
node --test "tests/engine.test.js"
```

> Pass the explicit file. `node --test tests/` relies on directory discovery that
> varies between Node versions and can report "Cannot find module ... tests".

### Browser runner

Open `tests/tests.html` in a browser (it runs the exact same cases and prints a
pass/fail summary).

### What was actually run for this build

These results are real, not aspirational:

| Check | Command / page | Result |
| --- | --- | --- |
| Engine unit tests (Node) | `node --test "tests/engine.test.js"` | **49 passed, 0 failed** |
| Engine unit tests (browser) | `tests/tests.html` in headless Chrome | **49 passed, 0 failed** |
| Bulk generation sweep | 17 topics × 3 difficulties × 600 questions = **30,600 questions** | **0 failures** (structural validity + answer round-trip + explanation consistency + MCQ sanity) |
| Syntax check | `node --check` on all six `js/` files | **all OK** |
| UI smoke test | Headless Chrome driving `index.html` | **no console errors**; config → practice → wrong answer (correct answer shown) → next → end → results rendered with no `NaN`/`Infinity`/`undefined`; all review filters render |

The bulk sweep is not part of the shipped suite; it was a one-off verification
that every generated question is structurally valid, that its canonical answer
round-trips through the validator, and that integer explanations actually contain
the answer they describe.

---

## Deploying to GitHub Pages

1. Create a repository and push these files to it (keep the folder layout —
   `index.html` must be at the repository root, or in the folder you publish).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick your branch (usually `main`) and the folder `/ (root)`, then **Save**.
5. Wait a minute for the first build, then open the URL GitHub shows
   (typically `https://<user>.github.io/<repo>/`).

No configuration files, workflows or environment variables are needed — it is a
static site. `assets/favicon.svg` is local, so nothing is fetched from a CDN.

---

## Project structure

```
index.html          Markup for all screens (dashboard, config, practice, results)
css/styles.css      All styling: responsive layout, light/dark theme, print-friendly
js/validation.js    Answer parsing/normalisation and checking (pure)
js/generators.js    The 17 question generators, MCQ distractors, BODMAS evaluator (pure)
js/timer.js         Injectable-clock timer: count up/down, pause/resume, formatting (pure)
js/analytics.js     Result metrics, topic-wise breakdown, review filters (pure)
js/drills.js        Session state machine and question lifecycle
js/app.js           Screens, rendering and input handling (the only DOM controller)
assets/favicon.svg  Local icon
tests/cases.js      Shared test cases
tests/engine.test.js  Node test entry point
tests/tests.html    Browser test runner (same cases)
README.md           This file
```

The five pure modules (`validation`, `generators`, `timer`, `analytics`,
`drills`) contain no DOM, no timers and no side effects, which is what makes them
testable in both environments. `app.js` is the only file that touches the DOM.

### Load order

In `index.html` the scripts load in this order: `validation`, `generators`,
`timer`, `analytics`, `drills`, then `app`. The engine modules register
themselves on a shared `window.SM` namespace and look each other up lazily, so
the order is flexible at call time.

---

## Notes on behaviour and design decisions

- **Session states** are exactly `ready`, `running`, `paused`, `completed`,
  `cancelled`. A question's authoritative outcome is exactly one of `correct`,
  `incorrect`, `skipped`, `timedout`, and it can be finalised only once — every
  path (Enter, Skip, End drill, per-question timeout, countdown expiry) funnels
  through one guarded `finalise()`.
- **Paused time never counts** toward the session clock, the per-question clock
  or response times.
- **Countdown expiry** records the question that was on screen as `timedout` and
  ends the drill exactly once. **Manual "End drill"** records the abandoned
  question as `skipped` (and still reports it under "questions shown").
- **Malformed or empty input is not a wrong answer.** It is rejected as
  "invalid" and the question stays open; only a well-formed wrong answer is
  scored `incorrect`. Fraction drills additionally accept a whole-number answer
  when the value is a whole number, and (when the drill asks for lowest terms) a
  correct-but-unsimplified fraction is marked incorrect with a reason.
- **Multiple choice** is a mode over the same answer types, not a separate
  answer type, so scoring and analysis are identical for typed and MCQ answers.
- **Adaptive difficulty** (opt-in) starts one level above and adjusts after at
  least five answered questions: it rises when accuracy ≥ 80% and the average
  answer is under 12 s, and falls when accuracy drops below 50%. Fixed drills
  never change level.
- **The theme toggle is session-only** (it is not remembered) so the project
  keeps its no-storage promise.
- **No `NaN`, `Infinity` or misleading percentages.** Where a figure is
  undefined — no questions answered, no timed questions, a zero denominator —
  the UI shows an explicit "insufficient data" style message rather than a
  nonsense number.

---

## Known limitations

- **No persistence by design.** A refresh or accidental close discards the
  current drill and its analysis. There is no history to compare against.
- **Generated questions, not a curated question bank.** Patterns are
  parameterised, so a drill can repeat the same *pattern* quickly even though
  duplicate *questions* are avoided within a session. The number of distinct
  questions for a narrow setting (e.g. the 2× table only) is genuinely small.
- **Explanations are templates, not worked human reasoning.** They name the
  shortcut and state the result, but they are not a step-by-step tutor for every
  pattern.
- **Per-question timing uses a 200 ms heartbeat.** A per-question limit or a
  countdown can overshoot by up to ~0.2 s before it is detected.
- **Numerical scope is bounded intentionally.** For BODMAS and mixed arithmetic,
  generation requires integer intermediate results, non-negative values, and
  intermediate magnitudes ≤ 50 000, so some expressions a human could write are
  simply not generated.
- **Round-trip precision.** Decimal and percentage comparisons use a
  precision-based tolerance derived from the question's stated number of decimal
  places, so a value rounded differently by a wide margin is marked incorrect.
- **Division answers use "quotient R remainder"** (e.g. `17 R 3`); a plain
  decimal quotient is not accepted for remainder questions.
- **Accessibility is best-effort**, not audited against WCAG. Labels, focus
  management and keyboard shortcuts are provided, but there has been no formal
  screen-reader or contrast audit.

---

## License

Use it, fork it, teach with it. No warranty of any kind — check any figure that
matters to you against your own official material.
