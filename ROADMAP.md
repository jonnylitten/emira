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

**Priority order (set 2026-05-31):** file upload → session persistence → multi-tab → everything else. ✓ ALL ten near-term items shipped by 2026-06-01.

### ~~1. Filter OmniParser output by `interactivity`~~ ✓ shipped
`interactive_only` arg on `screenshot_mark` / `POST /screenshot`. Default `true` for omniparser (drops static text labels), `false` for dom (no-op). OmniParser sidecar passes through the upstream `interactivity` flag; DOM detector always sets it to `true`. `labels` responses now include the `interactive` field.

### ~~2. Pre-inference region cropping~~ ✓ shipped
When `region` is set and detector is omniparser, the screenshot is cropped via sharp BEFORE inference. Coords come back in crop space and get translated to page space for the labelMap. DOM path unchanged (it queries the live page, not the screenshot). Saved screenshot dimensions match the region exactly.

### ~~3. Multi-tab support~~ ✓ shipped
New `TabRegistry` (src/tabs.ts) owns the set of open tabs. Monotonically-increasing numeric ids, stable for the process lifetime, never recycled. Each tab has its own label state — labels are per-screenshot per-tab, so switching tabs doesn't pollute state.

Four new tools: `open_tab(url?, wait_ms?)`, `switch_tab(tab_id)`, `list_tabs()`, `close_tab(tab_id?)`. Every existing action tool gains an optional `tab_id` parameter that defaults to the active tab — pass it explicitly to act on a non-active tab without switching. `screenshot_mark` results now include `tab_id` so the agent always knows which tab it just captured.

**Popups auto-register.** target=_blank clicks, window.open, OAuth flows: the BrowserContext fires a 'page' event, which the registry listens for. The new tab shows up in the next `list_tabs` call with no special handling needed by the agent. Verified end-to-end against the-internet.herokuapp.com/windows.

**Close behavior:** closing the active tab promotes the lowest remaining id. Closing the last tab auto-spawns a fresh blank one so the session is always usable.

### ~~4. `find_label` re-ranking heuristics~~ ✓ shipped
Two fixes in `scoring.ts`:
1. **Stopped double-counting type.** The haystack used to be `${el.text} ${el.type}` concatenated, which meant query word "input" matched type=input both as a text token (+3) AND as the explicit type-bonus (+2) — beating elements whose actual text contained the search term. Now only `el.text` goes into the text-token haystack; type matching is its own clean step.
2. **Added input-synonym set.** `input`, `textarea`, `textbox`, `combobox`, `searchbox`, `field`, `textfield` all match the input-like intent. So a query for "search input" now correctly ranks a `<input role="combobox">` whose text is "Search" higher than an `<input>` whose text is "Enter your email".

Verified live on github.com's open search modal:
| Query | Before | After |
|---|---|---|
| `find_label "search input"` top result | "Enter your email" (input, score 5) — wrong | "Search" (combobox, score 5) — right |

3 new regression tests in `scoring.test.ts` (32 total now): the GitHub combobox case, "email input" still ranks email correctly (no over-correction), and the button-type bonus still works (no regression in the unrelated path).

### ~~5. `main_content_only` on `get_page_text`~~ ✓ shipped
Optional `main_content_only` arg. Prefers `<main>` / `<article>` / `[role="main"]` over `<body>`, falls back to body when no semantic root is found.

### ~~6. Detector cost reporting~~ ✓ shipped
`detect_ms` returned in HTTP response; MCP response text now includes `Detector: omniparser (12400ms)` so the model learns relative cost without instrumentation.

### Parity-with-BrowserControl pack

Borrowed-feature ideas surfaced from a 2026-05-31 comparison against [adityasasidhar/browsercontrol](https://github.com/adityasasidhar/browsercontrol), the only other MCP server doing Set-of-Marks. All items in this pack shipped by 2026-06-01.

**Status as of 2026-06-01:** Marksman went from 11 → 21 tools, closing the table-stakes gaps (multi-tab, cookies, file upload, persistent profile, JS escape hatch) while keeping its unique edges (OmniParser detector, `find_label`, `get_page_text`, HTTP control surface). Where it's still behind: BrowserControl's DevTools surface (console/network/perf — not in roadmap) and session recording (longer-term).

See the current comparison table in [README.md → "How marksman compares"](./README.md#how-marksman-compares). The items below are kept here for historical/citation continuity.

#### ~~7. Cookie tools~~ ✓ shipped
Three tools: `get_cookies(urls?)`, `set_cookie({name, value, url?|domain?, ...})`, `clear_cookies({name?, domain?, path?})`. Context-level (no `tab_id` — cookies are shared across all tabs in the BrowserContext). All thin wrappers over Playwright's `context.cookies()` / `context.addCookies()` / `context.clearCookies()`. Smoke-tested against httpbin: read, set, scoped clear, full clear all behave correctly.

#### ~~8. File upload~~ ✓ shipped
`upload_at_label(label, path, timeout_ms?)` on MCP / `POST /upload` on HTTP. Two-strategy implementation: first tries `setInputFiles` after resolving the bbox-center element via `elementFromPoint` (handles both direct `<input type="file">` clicks and `<label for=...>` clicks). Falls back to arming a `filechooser` event listener before clicking — handles buttons/links that open a file dialog. `path` accepts single string or array (for multi-file inputs). Verified end-to-end against `the-internet.herokuapp.com/upload`.

#### ~~10. Session / profile persistence~~ ✓ shipped
Swapped `chromium.launch()` for `chromium.launchPersistentContext()`. Profile dir resolved by priority: `MARKSMAN_PROFILE_DIR` env > `$CLAUDE_PLUGIN_DATA/profile` (plugin mode, survives updates) > `~/.cache/marksman/profile` (dev/standalone). Plugin manifest exposes a `profile_dir` userConfig knob.

New `clear_profile` MCP tool / `POST /clear_profile` HTTP endpoint — wipes the dir and restarts with a fresh context (logout-like). Verified end-to-end: localStorage persists across separate Node processes on https origins; `clear_profile` wipes the dir; next `getPage()` recreates it clean.

**Caveat shipped with it:** file:// URLs don't persist localStorage in chromium's user-data dir (file origins partition differently). https origins work as expected. Persistent contexts take ~1s longer to launch than ephemeral ones.

#### ~~9. `run_javascript` escape hatch~~ ✓ shipped
`run_javascript(code, await_promise?)` MCP / `POST /run_javascript` HTTP. The code is treated as a function body — use `return X` to send a value back. Wraps in an IIFE (`(() => { code })()`) for sync, `(async () => { code })()` for async. Result JSON-serialized; non-serializable values become undefined. Truncates at 4000 chars in MCP text responses. Each call logged to stderr (`[marksman] run_javascript: …`) for audit visibility — doesn't pollute MCP stdio.

Smoke-tested sync (`return document.title`), async (`return await fetch(...).then(r => r.json())`), localStorage round-trip, and error propagation.

## Longer-term

### GPU / MPS support for OmniParser
The sidecar runs CPU-only on macOS today — every inference is 10–20s. Apple Silicon's MPS backend should drop this to 2–4s. Florence-2 and YOLO both support MPS in recent PyTorch.

**Why later:** Florence-2 has had MPS compatibility regressions in some transformers releases. Worth waiting for a known-good combination rather than chasing it now.

### Public marketplace listing
Currently the repo is private and installation requires being a collaborator. Flipping public unlocks `claude plugin install marksman@marksman` for anyone, but invites issues from people who hit OmniParser setup pain or Apple-Silicon-only paths.

**Plan:** Public flip is one CLI command (`gh repo edit --visibility public`). Gate on: (a) at least one external test on a Linux + nvidia box, (b) a CI run that validates the plugin builds clean, (c) a release with a real `version` field so installs are reproducible.

### Session recording (replay debugging)
Save labelMaps + screenshots to disk so a run that goes wrong can be replayed step-by-step. Distinct from item 10 (browser-state persistence): this is dev-time observability, not user-state continuity.

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
