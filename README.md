# marksman

Set-of-Marks browser control for LLM agents. Marksman takes a screenshot, overlays numbered labels on every interactive element, and exposes click / type / scroll / etc. keyed by label number. The agent picks "label 14" from the marked image instead of `click(743, 312)` — labels stay stable when the page reflows.

```
┌─────────────────────────────┐
│ marksman                    │
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

## Why

| | Raw coordinates | SoM labels |
|---|---|---|
| UI reflows | Breaks | Stable — same element keeps its label across screenshots* |
| Model output | `click(743, 312)` | `click_label(14)` |
| Debuggability | Hard — what's at `(743, 312)`? | Easy — label 14 is "Submit order" |
| Works on canvas/WebGL | No (DOM-only) | Yes, with the OmniParser detector |
| Validation | Click could land anywhere | If the model picks label 999 and there are 32 labels, you catch it before firing |

\* Within a single screenshot. The label map is rebuilt on every `screenshot_mark` call, so any DOM-changing action (click, navigate, scroll) invalidates the previous labels — always re-screenshot before the next interaction.

## Install

Marksman is a Claude Code plugin. Two ways to install:

**As an installed plugin** (recommended for end-users):

```bash
claude plugin install marksman@<marketplace>     # once a marketplace ships it
```

On first session, a `SessionStart` hook installs Node deps + Playwright's Chromium into the plugin's persistent data dir (~56MB). The bundled skill (`skills/marksman/SKILL.md`) auto-loads so Claude knows when to reach for the tools.

**For local development on marksman itself** (or to try before publishing):

```bash
cd marksman
npm install
npx playwright install chromium
npm run build
claude --plugin-dir .                            # loads the plugin for one session
```

Optional, for vision-based detection (catches canvas/WebGL UIs):

```bash
bash scripts/setup-omniparser.sh                 # ~15–60 min, ~1GB of weights
```

Then in the `/plugin` config (or via env), set `detector: omniparser` and point `omniparser_path` at the cloned repo.

## Use

### From Claude Code (plugin-loaded)

Once installed (or running with `--plugin-dir`), marksman's tools are available as `screenshot_mark`, `click_label`, `type_at_label`, `scroll`, `find_label`, `get_page_text`, `press_key`, `hover_label`, `go_back`, `go_forward`, `wait_for_load`. The skill description tells Claude when to use them, so a prompt like "open https://github.com/login and sign me in" just works.

### Plugin configuration

The plugin exposes three `userConfig` options (set them via `/plugin config marksman`):

| Option | Default | What it does |
|---|---|---|
| `detector` | `dom` | `dom` (fast DOM walker) or `omniparser` (vision-based, requires setup). Can also be overridden per-call. |
| `omniparser_path` | — | Absolute path to a cloned `microsoft/OmniParser` repo. Only required when `detector=omniparser`. |
| `headless` | `true` | Run Chromium without a window. Turn off to watch what marksman does. |

### From a script / agent (HTTP)

```bash
node dist/http-server.js                       # listens on :17542
```

```bash
curl -X POST localhost:17542/screenshot \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# {
#   "count": 1,
#   "image_path": "/tmp/marksman/shot-1.png",
#   "url": "https://example.com/",
#   "detector": "dom",
#   "labels": [{"label":1,"type":"a","text":"Learn more"}]
# }

curl -X POST localhost:17542/click \
  -H 'content-type: application/json' \
  -d '{"label":1}'
# {"ok":true, "x":297, "y":207, "url":"https://www.iana.org/help/example-domains"}
```

Screenshots are written to disk so an agent can `Read` them by path instead of shuttling base64.

## Toolkit

Same actions, two surfaces. MCP tools use snake_case names; HTTP endpoints use the shorter forms.

| MCP tool / HTTP endpoint | What it does |
|---|---|
| `screenshot_mark` / `POST /screenshot` | Capture, detect, label, return marked image + element list. Optional params: `url` (navigate first), `wait_ms` (extra delay after navigation, for animations / deferred renders), `fullpage` (capture the whole scrollable page, not just the viewport), `region: {x,y,w,h}` (crop into a dense part of the page), `detector` (`dom` or `omniparser`). |
| `click_label` / `POST /click` | Click center of label N |
| `type_at_label` / `POST /type` | Focus label N and type text (optional `clear` to select-all + delete first) |
| `scroll` / `POST /scroll` | Wheel scroll up or down by pixel amount |
| `find_label` / `POST /find_label` | Rank the last screenshot's labels against a natural-language description ("the Submit button"). Returns top matches with scores. |
| `get_page_text` / `POST /get_text` | Dump page innerText (or one labeled element's text). Avoids a screenshot round-trip when you just need to read. |
| `press_key` / `POST /press_key` | Send a key — `"Enter"`, `"Escape"`, `"Tab"`, `"Meta+A"`, etc. |
| `hover_label` / `POST /hover` | Move mouse to label N without clicking (for hover-revealed menus) |
| `go_back` / `POST /back` | Browser back |
| `go_forward` / `POST /forward` | Browser forward |
| `wait_for_load` / `POST /wait_for_load` | Wait for `"load"` \| `"domcontentloaded"` \| `"networkidle"` |

Every action that can change the URL returns the new `url` in its response, so the caller doesn't need a follow-up screenshot just to confirm where it landed.

## Detectors

| Name | How | Pros | Cons |
|---|---|---|---|
| `dom` (default) | Walks the live DOM via `page.evaluate`, picks interactive elements (`a`, `button`, `input`, form controls, `[role=*]`, etc.), filters by visibility, merges associated `<label>` text into form-control text. | Fast (~10ms), no setup, accurate for standard web UIs. | Misses canvas / WebGL elements, and any UI rendered without a real DOM element. |
| `omniparser` | Python sidecar runs Microsoft's OmniParser (YOLO icon detector + Florence captioner + OCR) over the screenshot pixels. | Catches canvas-rendered UIs (Figma, Maps, etc.), works on any rendered page. | Heavy: ~1GB weights, GPU recommended, seconds per inference. |

**Select per process:**

```bash
export MARKSMAN_DETECTOR=omniparser
```

**Or per call (HTTP):**

```bash
curl -X POST localhost:17542/screenshot -d '{"detector":"omniparser","url":"..."}'
```

**Or per call (MCP):** pass `detector: "omniparser"` to `screenshot_mark`.

### OmniParser setup

```bash
bash scripts/setup-omniparser.sh
export MARKSMAN_DETECTOR=omniparser
export MARKSMAN_OMNIPARSER_PATH="$PWD/omniparser/OmniParser"
```

The setup script creates a venv at `omniparser/.venv`, clones `microsoft/OmniParser` into `omniparser/OmniParser`, installs its dependencies, and downloads model weights via `huggingface-cli`. The Python sidecar (`omniparser/infer.py`) is spawned lazily on first detection and kept alive for the marksman process lifetime.

The sidecar protocol is line-delimited JSON over stdin/stdout:

```
sidecar → node: {"event":"ready"}
node → sidecar: {"request_id":"<uuid>","image_path":"/tmp/.../shot.png"}
sidecar → node: {"request_id":"<uuid>","elements":[{"bbox":{"x":..,"y":..,"w":..,"h":..},"type":"...","text":"..."}]}
```

For a protocol-only smoke test without downloading model weights:

```bash
bash scripts/setup-omniparser.sh --stub
MARKSMAN_OMNI_STUB=1 MARKSMAN_DETECTOR=omniparser node dist/http-server.js
```

The stub returns one centered placeholder bbox per request — enough to exercise the Node↔Python plumbing.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `MARKSMAN_HEADLESS` | `true` | Set to `false` to see the browser window. |
| `MARKSMAN_HTTP_PORT` | `17542` | HTTP server port. |
| `MARKSMAN_SHOT_DIR` | `/tmp/marksman` | Where marked PNGs are written. |
| `MARKSMAN_DETECTOR` | `dom` | `dom` or `omniparser`. |
| `MARKSMAN_OMNIPARSER_PATH` | — | Absolute path to a cloned `microsoft/OmniParser` repo. Required when using the omniparser detector. |
| `MARKSMAN_OMNI_STUB` | — | Set to `1` to use the sidecar's stub mode (no model load). |
| `MARKSMAN_OMNI_YOLO_WEIGHTS` | `<repo>/weights/icon_detect/best.pt` | YOLO weight path override. |
| `MARKSMAN_OMNI_CAPTION_WEIGHTS` | `<repo>/weights/icon_caption_florence` | Florence weight path override. |

## Development

```bash
npm run build         # tsc → dist/
npm run dev           # tsc --watch
npm run typecheck     # tsc --noEmit
npm test              # vitest run — pure-function unit tests
npm run test:watch
```

Tests cover `scoring.ts`, `geometry.ts`, and `annotate.ts` (the parts that don't need a browser). End-to-end coverage is via agent runs against real sites — see the smoke driver at `scripts/smoke.mjs` for the MCP wire protocol if you want to write your own.

## Project layout

```
.claude-plugin/
└── plugin.json              Plugin manifest (name, version, mcpServers, userConfig)
skills/
└── marksman/SKILL.md        Skill description — loaded into Claude's context on plugin activation
hooks/
└── hooks.json               SessionStart hook → scripts/install-plugin-deps.sh
scripts/
├── install-plugin-deps.sh   Idempotent npm install + Playwright Chromium install into $CLAUDE_PLUGIN_DATA
├── setup-omniparser.sh      One-shot installer for the omniparser detector
└── smoke.mjs                MCP stdio smoke driver
src/
├── server.ts                MCP stdio server (the plugin's MCP entry point)
├── http-server.ts           HTTP server (for curl / out-of-Claude-Code scripting)
├── controller.ts            Shared action layer — owns label map + browser session
├── browser.ts               Playwright session singleton
├── detect.ts                DOM detector implementation
├── detector.ts              Dispatcher: dom | omniparser
├── detectors/
│   └── omniparser.ts        Node-side Python sidecar client
├── annotate.ts              sharp + SVG composite for the marked image
├── scoring.ts               find_label fuzzy ranker
├── geometry.ts              bbox helpers (intersect, containment, suppression)
├── types.ts
└── *.test.ts                vitest suites
omniparser/
├── infer.py                 Python sidecar (real OmniParser + --stub mode)
├── inference-requirements.txt
└── requirements.txt
```

## Limitations

- **The label map is per-screenshot.** Any action that changes the DOM (click, navigate, scroll past new content) invalidates the previous labels. Always re-screenshot before the next interaction. The error message on stale labels says so.
- **The DOM detector misses canvas / WebGL.** Use OmniParser for Figma, Google Maps, Three.js apps.
- **Hover-revealed UI with a non-interactive trigger** (e.g., `<div class="card">` that reveals a menu on `:hover`) won't be caught by the DOM detector — the trigger isn't a real interactive element. Again, OmniParser handles it.
- **Single-tab, single-page.** No multi-tab support yet; the controller is a process singleton.
- **`get_page_text` returns full body innerText**, including site chrome (nav, footer). Pass `max_chars` to truncate, or grep within the result.

## Agent prompting tips

If you're writing prompts that drive marksman, a few patterns that work well:

- Tell the agent to **view the marked PNG with the Read tool** after every `screenshot_mark` (or HTTP `/screenshot`). The `labels` metadata alone is often empty (form inputs have no innerText); the image is where the meaning is.
- After any action that could change the page, instruct: "Re-screenshot before the next click — label numbers reset."
- For text-heavy verification (reading article content, JSON responses, search results), use `get_page_text` instead of trying to OCR the screenshot.
- For "click the thing that says X", use `find_label "X"` first to get the label number, then `click_label`.
- Use `press_key Enter` to submit forms instead of finding the submit button — usually shorter.
