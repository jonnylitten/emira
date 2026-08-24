# emira

Browser control for LLM agents, built on Set-of-Marks. Emira screenshots a page, overlays numbered labels on every interactive element, and lets the agent act by label number: it picks "label 14" from the marked image instead of guessing `click(743, 312)`.

```
┌─────────────────────────────┐
│ emira                    │
│                             │
│  ┌────────┐  ┌───────────┐  │
│  │ MCP    │  │ HTTP      │  │   ← two control surfaces, same actions
│  └────┬───┘  └─────┬─────┘  │
│       └────┬───────┘        │
│       ┌────▼─────┐          │
│       │Controller│          │   ← owns label state, browser session
│       └────┬─────┘          │
│       ┌────▼─────┐          │
│       │ Detector │  ◀──── dom (DOM walk) | omniparser (Python sidecar)
│       └────┬─────┘          │
│       ┌────▼─────┐          │
│       │Playwright│          │
│       └──────────┘          │
└─────────────────────────────┘
```

## Why it's unique

- **Native file-picker uploads.** `upload_at_label` clicks a styled upload button, catches the OS-level file dialog, and attaches the files. This carried a full App Store Connect submission end to end, eight screenshots included (see the [case study](#case-study-a-full-app-store-connect-submission)).
- **Vision detection for canvas and WebGL.** The OmniParser detector labels clickable elements in canvas-rendered UIs (Figma, Google Maps, Three.js apps) that a DOM walker structurally cannot see.
- **One action set, two surfaces.** The same toolkit ships as a Claude Code plugin over MCP (21 tools) and as a loopback HTTP API on `:17542` (21 endpoints), so agent sessions and non-agent callers (batch scripts, cron jobs, services in other languages) get identical primitives.
- **Labels are stable and bounded.** Within a screenshot an element keeps its number as the page reflows, each label is self-describing (label 14 is "Submit order"), and a label outside the current set is caught before it fires.
- **Natural-language lookup.** `find_label "the submit button"` ranks the last screenshot's labels by description, so the agent acts by intent instead of tracking numbers.
- **Read without a screenshot.** `get_page_text` with `main_content_only` returns the article body past nav and footer chrome, with no image round-trip.

## Install

Emira is a Claude Code plugin. Two ways to install:

**As an installed plugin** (recommended for end-users):

```bash
claude plugin install emira@<marketplace>     # once a marketplace ships it
```

On first session, a `SessionStart` hook installs Node deps + Playwright's Chromium into the plugin's persistent data dir (~56MB). The bundled skill (`skills/emira/SKILL.md`) auto-loads so Claude knows when to reach for the tools.

**For local development on emira itself** (or to try before publishing):

```bash
cd emira
npm install
npx playwright install chromium
npm run build
claude --plugin-dir .                            # loads the plugin for one session
```

Optional, for vision-based detection (catches canvas/WebGL UIs):

```bash
bash scripts/setup-omniparser.sh                 # ~15-60 min, ~1GB of weights
```

Then in the `/plugin` config (or via env), set `detector: omniparser` and point `omniparser_path` at the cloned repo.

## Use

### From Claude Code (plugin-loaded)

Once installed (or running with `--plugin-dir`), all 21 emira tools are available. The skill description tells Claude when to use them, so a prompt like "open https://github.com/login and sign me in" just works. See [Toolkit](#toolkit) for the full list.

### Plugin configuration

The plugin exposes nine `userConfig` options (set them via `/plugin config emira`):

| Option | Default | What it does |
|---|---|---|
| `detector` | `dom` | `dom` (fast DOM walker) or `omniparser` (vision-based, requires setup). Can also be overridden per-call. |
| `omniparser_path` | (none) | Absolute path to a cloned `microsoft/OmniParser` repo. Only required when `detector=omniparser`. |
| `headless` | `true` | Run Chromium without a window. Turn off to watch what emira does. |
| `executable_path` | (none) | Absolute path to a Chromium/Chrome binary to drive instead of Playwright's bundled Chromium. Pair with `headless: false` to hand-solve a captcha in a real window. Blank uses the bundled Chromium. |
| `allow_escalated` | `false` | Enables `run_javascript`, `upload_at_label`, and the cookie tools. Off means they refuse on both surfaces. See [Security and threat model](#security-and-threat-model). |
| `upload_root` | (none) | Directory `upload_at_label` may read files from. Blank means uploads are disabled. |
| `persist_profile` | `false` | Reuse the browser profile across runs instead of a throwaway one. Turning it on means the browser carries real credentials. |
| `profile_dir` | (none) | Where the browser profile lives when persistence is on. Defaults to `${CLAUDE_PLUGIN_DATA}/profile`. |
| `viewport` | `1440x900` | Browser viewport as `WIDTHxHEIGHT`. Increase it for wide app UIs that render cramped at smaller widths. |

### From a script / agent (HTTP)

```bash
node dist/http-server.js                       # listens on 127.0.0.1:17542
```

The HTTP surface requires a bearer token on every request. Token resolution order is `EMIRA_HTTP_TOKEN`, then whatever is already in `~/.emira/http-token`, then a fresh random token. Whichever wins is written back to `~/.emira/http-token` (mode `0600`), so a local client can read it from there rather than coordinating env vars, and a token generated once survives restarts:

```bash
TOKEN=$(cat ~/.emira/http-token)

curl -X POST localhost:17542/screenshot \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# {
#   "count": 1,
#   "image_path": "~/.emira/shots/shot-1.png",
#   "url": "https://example.com/",
#   "detector": "dom",
#   "detect_ms": 9,
#   "tab_id": 1,
#   "labels": [{"label":1,"type":"a","text":"Learn more","interactive":true}]
# }

curl -X POST localhost:17542/click \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":1}'
# {"ok":true, "x":297, "y":207, "url":"https://www.iana.org/help/example-domains", "tab_id":1}
```

`content-type: application/json` is mandatory, not cosmetic. So is the absence of an `Origin` header. See [Security and threat model](#security-and-threat-model) for why, and for the endpoints that are disabled by default.

`GET /healthz` is the one route that needs neither a token nor a body.

Screenshots are written to disk so an agent can `Read` them by path instead of shuttling base64.

## Toolkit

Same actions, two surfaces. MCP tools use snake_case names; HTTP endpoints use the shorter forms. **21 MCP tools, mirrored one-for-one by 21 HTTP POST endpoints**, plus `GET /healthz` on the HTTP side (22 routes total).

Every tool that acts on a page takes an optional `tab_id` to address a non-active tab; omit it to act on the active tab. The cookie tools, `clear_profile`, and the tab-registry tools (`open_tab`, `switch_tab`, `list_tabs`) don't take one, because they operate on the browser context as a whole.

### Page interaction

| MCP tool / HTTP endpoint | What it does |
|---|---|
| `screenshot_mark` / `POST /screenshot` | Capture, detect, label, return marked image + element list. Optional params: `url` (navigate first), `wait_ms` (extra delay after navigation, for animations / deferred renders), `fullpage` (capture the whole scrollable page, not just the viewport), `region: {x,y,w,h}` (crop into a dense part of the page), `detector` (`dom` or `omniparser`), `interactive_only` (drop non-interactive detections; defaults on for omniparser, no-op for dom). |
| `click_label` / `POST /click` | Click center of label N |
| `type_at_label` / `POST /type` | Focus label N and type text (optional `clear` to select-all + delete first). Types via real key events, so React-controlled inputs register the change. |
| `upload_at_label` / `POST /upload` | Attach one file or an array of files at label N. Works for a direct `<input type="file">` and for buttons that open a native OS file picker on click. `path` is absolute on the emira host, and must sit inside `EMIRA_UPLOAD_ROOT`. |
| `scroll` / `POST /scroll` | Wheel scroll up or down by pixel amount |
| `press_key` / `POST /press_key` | Send a key: `"Enter"`, `"Escape"`, `"Tab"`, `"Meta+A"`, and other Playwright key strings |
| `hover_label` / `POST /hover` | Move mouse to label N without clicking (for hover-revealed menus) |

### Reading and finding

| MCP tool / HTTP endpoint | What it does |
|---|---|
| `find_label` / `POST /find_label` | Rank the last screenshot's labels against a natural-language description ("the Submit button"). Returns top matches with scores. |
| `get_page_text` / `POST /get_text` | Dump page innerText (or one labeled element's detected text). `main_content_only` prefers `<main>`/`<article>`/`[role=main]` over `<body>`. Avoids a screenshot round-trip when you just need to read. |
| `run_javascript` / `POST /run_javascript` | Run a JS function body in the page. `return X` sends a value back; `await_promise: true` wraps it in an async function. Gated by default; once enabled for a trusted target it is the primary tool for stateful work the label loop can't express, not a last resort (see the [case study](#case-study-a-full-app-store-connect-submission)). Every call is logged to stderr. |

### Navigation and tabs

| MCP tool / HTTP endpoint | What it does |
|---|---|
| `go_back` / `POST /back` | Browser back |
| `go_forward` / `POST /forward` | Browser forward |
| `wait_for_load` / `POST /wait_for_load` | Wait for `"load"` \| `"domcontentloaded"` \| `"networkidle"` |
| `open_tab` / `POST /open_tab` | Open a new tab (optionally navigating) and make it active. Returns its `tab_id`. |
| `switch_tab` / `POST /switch_tab` | Change the active tab |
| `list_tabs` / `POST /list_tabs` | List every open tab with id, url, title, and which is active. Popups from `target=_blank` and `window.open` are auto-registered, so this is how you find them. |
| `close_tab` / `POST /close_tab` | Close a tab (defaults to active). Closing the last tab opens a fresh blank one so the session stays usable. |

### Session state

| MCP tool / HTTP endpoint | What it does |
|---|---|
| `get_cookies` / `POST /get_cookies` | List cookies, optionally filtered to the ones the browser would send to given URLs |
| `set_cookie` / `POST /set_cookie` | Set a cookie on the context |
| `clear_cookies` / `POST /clear_cookies` | Clear cookies, optionally filtered by `name`/`domain`/`path`. No filter clears everything. |
| `clear_profile` / `POST /clear_profile` | Wipe the browser profile directory (cookies, localStorage, IndexedDB, downloads) and restart with a fresh context |

Every action that can change the URL returns the new `url` and `tab_id` in its response, so the caller doesn't need a follow-up screenshot just to confirm where it landed.

On both surfaces, `run_javascript`, `upload_at_label`, and the three cookie tools are disabled unless `EMIRA_ALLOW_ESCALATED=1`. `upload_at_label` additionally requires `EMIRA_UPLOAD_ROOT` and only reads files inside it, navigation is limited to `http:` and `https:`, and bulk `get_page_text` output is fenced as untrusted content. See [Security and threat model](#security-and-threat-model).

## Case study: a full App Store Connect submission

On 2026-07-22, an agent drove emira through an entire iOS App Store submission end to end in the browser, reaching "Waiting for Review". The only step outside emira was the Xcode archive upload, which is a native app rather than a web page.

App Store Connect is close to a worst case for browser automation: a heavy React SPA with modals, native OS file pickers, multi-step wizards, sticky footer controls below the fold, and validation that crosses page boundaries. Three capabilities carried the run:

- **`upload_at_label` against a native file picker.** The "Choose File" controls open the OS file dialog rather than exposing a bare `<input type="file">`. emira catches Playwright's `filechooser` event and sets the files, so the dialog is never a dead end. This is where most naive automation stops.
- **`type_at_label` with `clear: true` on React inputs.** Typing goes through real keyboard events, so React's `onChange` fires and component state updates. Assigning `.value` directly is the classic failure: the field looks filled and the form still believes it is empty.
- **`run_javascript` for stateful work.** Auditing which radio groups across a 7-page wizard were still unanswered, locating the real "Submit for Review" button in a sticky footer by text and geometry, and reading validation banners and `disabled` state, none of which the screenshot loop expresses well.

The full field report, including every rough edge hit and a feature wishlist, is in [`docs/field-report-2026-07-app-store-connect.md`](docs/field-report-2026-07-app-store-connect.md).

## Security and threat model

Emira drives a real browser that may hold live logged-in sessions, and page content flows into the agent's context. Both facts shape the controls. The policy is declared once in [`src/policy.ts`](src/policy.ts) and enforced inside the controller, so MCP and HTTP get the same checks and a tool added later cannot skip them. Refusals raise a typed `PolicyError` that names the rule and the env var that relaxes it.

The main controls:

- **Escalated tools are gated.** `run_javascript`, `upload_at_label`, and the three cookie tools are off until `EMIRA_ALLOW_ESCALATED=1`. The gate covers both surfaces, because the threat is prompt injection, which attacks the agent, not the network port.
- **Navigation is restricted.** Only `http:` and `https:` are navigable, and link-local plus cloud-metadata addresses are refused. Set `EMIRA_ALLOWED_HOSTS` to pin an allowlist. This is best-effort, not a full SSRF defense.
- **Uploads are confined.** Disabled until `EMIRA_UPLOAD_ROOT` names a directory, and `upload_at_label` only reads paths inside it, with symlinks resolved first.
- **Page text is fenced.** Bulk `get_page_text` comes back wrapped in `<untrusted-page-content>` to mark the trust boundary in the transcript. A mitigation, not a fix.
- **The HTTP surface is closed by default.** Loopback bind, a bearer token on every request, and `Origin`/`Content-Type` checks that reject browser-issued requests outright.
- **The profile is ephemeral by default.** A throwaway profile per run, deleted on shutdown, so a run gone wrong has no cookies to lose. Persistence is opt-in via `EMIRA_PERSIST_PROFILE=1`.

What emira does **not** defend: prompt injection itself, DNS-based SSRF, unfenced label text, cross-tab origin isolation, and human confirmation (emira never asks before it clicks). If you point an agent at untrusted pages while a persistent profile holds real credentials, assume anything reachable from that browser is reachable by anything the agent reads.

The full threat model, control by control, is in [`docs/threat-model.md`](docs/threat-model.md).

## Detectors

| Name | How | Pros | Cons |
|---|---|---|---|
| `dom` (default) | Walks the live DOM, picks interactive elements, filters by visibility, merges `<label>` text into form controls. | Fast (~10ms), no setup, accurate for standard web UIs. | Misses canvas / WebGL and anything without a real DOM element. |
| `omniparser` | Python sidecar runs Microsoft's OmniParser (icon detector + captioner + OCR) over the screenshot pixels. | Catches canvas-rendered UIs (Figma, Maps, web games). | Heavy: ~1GB weights, GPU recommended, 10 to 20s per inference on CPU. |

Select per process with `EMIRA_DETECTOR=omniparser`, or per call by passing `detector: "omniparser"` to `screenshot_mark` (MCP) or in the JSON body (HTTP). The sidecar is CPU-only today, so each inference takes roughly 10 to 20 seconds, and the first call in a session is slower still while it loads about 1GB of weights. GPU and Apple MPS work is tracked in [ROADMAP.md](./ROADMAP.md).

Setup, weight overrides, the stub mode, and the Node to Python sidecar protocol are in [`docs/detectors.md`](docs/detectors.md).

## Configuration

**Browser:**

| Env var | Default | What it does |
|---|---|---|
| `EMIRA_HEADLESS` | `true` | Set to `false` to see the browser window. |
| `EMIRA_VIEWPORT` | `1440x900` | Viewport size, as `WIDTHxHEIGHT`. Set at launch; there is no runtime resize tool. |
| `EMIRA_EXECUTABLE_PATH` | (none) | Absolute path to a Chromium/Chrome binary to drive instead of Playwright's bundled Chromium. |
| `EMIRA_PERSIST_PROFILE` | (none) | Set to `1` (or `true`) to reuse the on-disk profile across runs. Off means a throwaway profile that is deleted on shutdown. See [Security and threat model](#security-and-threat-model). |
| `EMIRA_PROFILE_DIR` | `$CLAUDE_PLUGIN_DATA/profile`, else `~/.cache/emira/profile` | Where the persistent profile lives. Only used when `EMIRA_PERSIST_PROFILE` is on. |

**HTTP surface:**

| Env var | Default | What it does |
|---|---|---|
| `EMIRA_HTTP_PORT` | `17542` | HTTP server port. |
| `EMIRA_HTTP_HOST` | `127.0.0.1` | Bind address. Changing this exposes a browser-driving service to the network. |
| `EMIRA_HTTP_TOKEN` | reuse `~/.emira/http-token`, else random | Bearer token required on every POST. Whichever token wins is always written back to `~/.emira/http-token` (mode `0600`). |
| `EMIRA_SHOT_DIR` | `~/.emira/shots` | Where marked PNGs are written (mode `0700`, verified at startup; emira refuses to start if the directory cannot be secured). HTTP surface only; MCP returns images inline. |
| `EMIRA_SHOT_TIMEOUT_MS` | `15000` | Screenshot capture timeout. A full-page capture that exceeds it falls back to a viewport capture rather than failing the call. |

**Security policy** (applies to MCP and HTTP alike, see [Security and threat model](#security-and-threat-model)):

| Env var | Default | What it does |
|---|---|---|
| `EMIRA_ALLOW_ESCALATED` | (none) | Set to `1` (or `true`) to enable `run_javascript`, `upload_at_label`, and the three cookie tools. Off means they refuse on both surfaces. |
| `EMIRA_UPLOAD_ROOT` | (none) | Directory that `upload_at_label` may read from. Unset means uploads are disabled. Paths are resolved through symlinks and must land inside this root. |
| `EMIRA_ALLOWED_HOSTS` | (none) | Comma-separated hostname allowlist for navigation. Unset means any `http`/`https` host except link-local and cloud metadata addresses. |

**Detection:**

| Env var | Default | What it does |
|---|---|---|
| `EMIRA_DETECTOR` | `dom` | `dom` or `omniparser`. |
| `EMIRA_OMNIPARSER_PATH` | (none) | Absolute path to a cloned `microsoft/OmniParser` repo. Required when using the omniparser detector. |
| `EMIRA_OMNI_PYTHON` | auto-detected | Explicit path to the Python binary for the sidecar. Otherwise emira looks for the venv `setup-omniparser.sh` created, then falls back to `python3` on PATH. |
| `EMIRA_OMNI_STUB` | (none) | Set to `1` to use the sidecar's stub mode (no model load). |
| `EMIRA_OMNI_YOLO_WEIGHTS` | `<repo>/weights/icon_detect/best.pt` | YOLO weight path override. |
| `EMIRA_OMNI_CAPTION_WEIGHTS` | `<repo>/weights/icon_caption_florence` | Florence weight path override. |

## Limitations

- **The label map is per-screenshot.** Any action that changes the DOM (click, navigate, scroll past new content) invalidates the previous labels. Always re-screenshot before the next interaction. The error message on stale labels says so.
- **The DOM detector misses canvas / WebGL.** Use OmniParser for Figma, Google Maps, Three.js apps.
- **Hover-revealed UI with a non-interactive trigger** (e.g., `<div class="card">` that reveals a menu on `:hover`) won't be caught by the DOM detector, since the trigger isn't a real interactive element. Again, OmniParser handles it.
- **One browser session per process.** Multi-tab works (`open_tab`, `switch_tab`, `list_tabs`, `close_tab`, plus auto-registered popups), and each tab keeps its own label map. But the controller is a process singleton, so all tabs share one Chromium context and one cookie jar. There is no way to run two isolated sessions inside one emira process.
- **No iframe traversal.** The DOM detector walks the top-level document only. Elements inside an `<iframe>` are not labeled.
- **Full-page screenshots can time out on heavy pages.** `fullpage: true` inherits Playwright's 30s screenshot timeout, and pages with large media components can exceed it, especially when the browser window is backgrounded and the OS throttles it. `region` crops are reliable where full-page captures are not.
- **No runtime viewport control.** The viewport is fixed at launch (`EMIRA_VIEWPORT`, default `1440x900`). There is no `set_viewport` tool, so a site that renders responsively to a wider window has to be relaunched, not resized.
- **Multi-file upload order is not guaranteed.** `upload_at_label` hands the whole array to the file chooser at once. A site that uploads them concurrently can land them out of order. Upload one at a time when slot order matters.
- **`get_page_text` with a `label` returns the element's detected text, not its value.** For a form control that is the label or placeholder, not what the user typed. Use `run_javascript` to read `.value` or `.checked`.
- **`get_page_text` without a label returns full body innerText**, including site chrome (nav, footer). Pass `main_content_only` to prefer `<main>`/`<article>`/`[role=main]`, `max_chars` to truncate, or grep within the result.

## Agent prompting tips

If you're writing prompts that drive emira, a few patterns that work well:

- Tell the agent to **view the marked PNG with the Read tool** after every `screenshot_mark` (or HTTP `/screenshot`). The `labels` metadata alone is often empty (form inputs have no innerText); the image is where the meaning is.
- After any action that could change the page, instruct: "Re-screenshot before the next click. Label numbers reset."
- For text-heavy verification (reading article content, JSON responses, search results), use `get_page_text` instead of trying to OCR the screenshot.
- For "click the thing that says X", use `find_label "X"` first to get the label number, then `click_label`.
- Use `press_key Enter` to submit forms instead of finding the submit button. Usually shorter.
- On heavy pages, prefer `region: {x,y,w,h}` crops over `fullpage: true`. Cropped captures are faster and do not hit the screenshot timeout.
- For anything stateful that spans several views (which fields are still blank, where a sticky footer button actually is, what a validation banner says), reach for `run_javascript` instead of screenshotting your way around. See the [case study](#case-study-a-full-app-store-connect-submission).
