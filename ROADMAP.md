# Roadmap

What's shipped, what's next, and what's deliberately out of scope. Living document — bump it when priorities shift.

## Shipped

| | |
|---|---|
| MCP server | 11 tools — `screenshot_mark`, `click_label`, `type_at_label`, `scroll`, `find_label`, `get_page_text`, `press_key`, `hover_label`, `go_back`, `go_forward`, `wait_for_load`. URL returned by every action that can navigate. |
| HTTP control surface | Same actions over `POST http://localhost:17542/<endpoint>`. Saves screenshots to disk for `Read`-tool consumption. |
| Detectors | DOM walker (default, ~10ms). OmniParser sidecar (vision-based, catches canvas/WebGL). Selectable via env var or per-call `detector` arg. |
| Plugin packaging | `.claude-plugin/{plugin.json,marketplace.json}`, SessionStart hook installing Node deps into `${CLAUDE_PLUGIN_DATA}`, ergonomic userConfig. Installable from `github.com/jonnylitten/marksman` (private). |
| Tests | 27 vitest unit tests over `scoring`, `geometry`, `annotate`. Pure-function coverage; browser integration verified via agent runs. |
| OmniParser setup | `scripts/setup-omniparser.sh` — Python 3.12 venv, minimal inference deps (no paddleocr/gradio/openai-required-only), three upstream patches applied automatically, weight download via `hf`. |

## Near-term

Ranked by impact. Pick one at a time.

### 1. Filter OmniParser output by `interactivity`
OmniParser tags each detected element as interactive (icon) or not (text label). On a Google Maps screenshot it returns ~126 elements — most are static place names that aren't clickable. The marked image becomes unreadable, and `find_label` ranks noise.

**Plan:** Pass through OmniParser's `interactivity` field in `normalize()`. Add an `interactive_only?: boolean` arg to `screenshot_mark` (default `true` for omniparser, no-op for DOM). When set, drop non-interactive elements before annotating.

### 2. Pre-inference region cropping
`region` currently filters elements AFTER detection. With OmniParser that means a full-page inference (~15s on CPU) even when the caller only wants a corner. Cropping the screenshot BEFORE running detection would 5–10× speedup for targeted detail.

**Plan:** Move the `extract` call in `controller.ts:screenshot()` so cropping happens before `detect()` is invoked. Translate bboxes between region-relative (annotation) and page-absolute (click) coordinates as today.

### 3. Multi-tab support
Single-tab is fine for one-off flows but fails for any task that needs to compare two pages, follow a popup, or keep an auth context alive while opening links. Currently a click that opens `_blank` is invisible to us.

**Plan:** Replace the singleton `Marksman` controller with a registry keyed by tab id. New tools: `open_tab`, `switch_tab`, `list_tabs`, `close_tab`. `screenshot_mark` and friends default to the active tab; per-call `tab_id` opt-in. Label maps become per-tab.

### 4. `find_label` re-ranking heuristics
The fuzzy-text ranker is fine for clear queries ("submit button") but ties on ambiguous ones. The agent flagged that "search" returned both the input *and* the button at the same score. A small bias toward `<input>` types when the description contains verbs implying typing ("search for X", "enter Y") would resolve ties usefully.

**Plan:** Add intent-detection pass in `scoring.ts` — keywords like "type", "enter", "search for" → boost score for input/textarea types. Keep it small; full NLU is overkill.

### 5. `main_content_only` on `get_page_text`
Wikipedia and similar sites prefix the body innerText with ~300 chars of nav/donate chrome. Agents currently bump `max_chars` to compensate, wasting tokens.

**Plan:** Optional `main_content_only?: boolean` arg. When true, prefer `<main>`, `<article>`, or `[role="main"]` element's innerText if present; fall back to body. Document the heuristic in the tool description so the model can disable it for sites with broken semantics.

### 6. Detector cost reporting
Surface the detection latency in the response text so the agent learns when DOM is enough vs when OmniParser pays off. Currently invisible.

**Plan:** Time the `detect()` call in `controller.ts:screenshot()`. Include `Detection: 12.4s` in the MCP response and a `detect_ms` field in the HTTP response.

## Longer-term

### GPU / MPS support for OmniParser
The sidecar runs CPU-only on macOS today — every inference is 10–20s. Apple Silicon's MPS backend should drop this to 2–4s. Florence-2 and YOLO both support MPS in recent PyTorch.

**Why later:** Florence-2 has had MPS compatibility regressions in some transformers releases. Worth waiting for a known-good combination rather than chasing it now.

### Public marketplace listing
Currently the repo is private and installation requires being a collaborator. Flipping public unlocks `claude plugin install marksman@marksman` for anyone, but invites issues from people who hit OmniParser setup pain or Apple-Silicon-only paths.

**Plan:** Public flip is one CLI command (`gh repo edit --visibility public`). Gate on: (a) at least one external test on a Linux + nvidia box, (b) a CI run that validates the plugin builds clean, (c) a release with a real `version` field so installs are reproducible.

### Session persistence
Save labelMaps + screenshots to disk so a run that goes wrong can be replayed step-by-step for debugging. Useful for the next time an agent loop falls over and we want to see exactly which screenshot the model misread.

**Plan:** Opt-in `MARKSMAN_RECORD_DIR` env var. Write each `screenshot_mark` result + each action to a JSONL log in that dir. Add a `scripts/replay.mjs` driver.

### Scroll-then-mark
"Find the submit button" on a 5000px page currently requires the agent to scroll-and-screenshot in a loop until it sees the button. A `find_label` variant that scrolls automatically until the described element comes into view would collapse that.

**Plan:** New tool `scroll_to_label` — takes a description, does fresh detection at the current scroll position, scrolls a fixed amount, repeats up to N times. Returns labels around the match.

## Open issues

- **`/reload-plugins` leaks Node MCP servers.** Claude Code bug — sometimes spawns a new MCP server without killing the old one, leaving zombies that hold stale code in their Python sidecars. Workaround: `pkill -f marksman/dist/server.js` between iterations. Reported nowhere yet.
- **OmniParser source patches survive on disk but die on re-clone.** If a user blows away `omniparser/OmniParser/` and re-runs the setup script, patches reapply. If they `git pull` inside that dir, patches are lost. Should detect and re-apply.
- **OmniParser CPU-only.** See longer-term section. ~15s/inference is acceptable for ad-hoc use, painful for any tight loop.
- **No CI.** Tests run locally only. A GitHub Actions workflow that runs `npm test` on push would catch regressions before they reach the cached plugin.
- **`hover_label` is hard to validate.** Hovering reveals state in the next screenshot, but for hover-revealed UIs where the trigger isn't a DOM element (e.g., `<div class="figure">` hovers), DOM detection misses the trigger entirely. OmniParser handles it. Document the workaround in SKILL.md.

## Won't do (reasoning kept so we don't relitigate)

- **Bundle OmniParser weights into the plugin.** ~1GB. Better to keep the setup script and let users opt in once per machine.
- **Built-in agent loop with OpenAI/Anthropic.** Out of scope — marksman is a tool surface for an existing agent, not an agent itself. The original OmniParser ships agent loops; we deliberately don't.
- **Auto-restart sidecar when `utils.py` mtime changes.** Tempting fix for the stale-Python-cache problem, but it's a development pain only — production users won't be editing OmniParser source. Solved by `pkill` during dev.
- **Multi-detector ensemble (DOM + OmniParser merged).** Each detector returns different element categories with different bboxes. Merging would require nontrivial deduplication and offers little vs picking the right detector per page.
- **Track `dist/` exclusion in `.gitignore`.** It's a shipping artifact for the plugin; the plugin's MCP server runs from `${CLAUDE_PLUGIN_ROOT}/dist/server.js`. Tracking it means commits are noisy but plugin installs are zero-setup.
