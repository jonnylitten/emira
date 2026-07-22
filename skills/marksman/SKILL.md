---
name: marksman
description: Browser automation by Set-of-Marks labeling. Use when the task requires controlling a real web browser, including clicking buttons, filling forms, uploading files, reading interactive pages, navigating, or any UI work that WebFetch can't do. Marksman screenshots the page, overlays numbered labels on every interactive element, and exposes 21 MCP tools keyed by label number.
---

# Marksman

Set-of-Marks browser control. Every interaction is keyed off a numbered, labeled screenshot rather than raw coordinates, so labels stay stable when the page reflows and the model picks `#14` instead of `click(743, 312)`.

## When to use this

Use marksman when the user wants Claude to drive a browser: fill a form, search a site and follow a result, verify a deployed UI, scrape content behind interactive controls, log into something, etc.

Do **not** use marksman for:
- Static page reads → `WebFetch` is much cheaper.
- API calls → `curl` / `fetch` directly.
- Anything that fits inside a single page load with no interaction.

## The core loop

1. `screenshot_mark` (with `url` to navigate, or no args to capture the current page). Returns a PNG marked with red boxes + numbered badges over every interactive element.
2. **View the image with the Read tool.** The `labels` metadata alone is often blank. Form inputs have no innerText, so the meaning lives in the picture.
3. Pick a label number (by eye, or via `find_label "..."` for natural-language lookup).
4. Act: `click_label`, `type_at_label`, `scroll`, `press_key`, etc.
5. **Re-screenshot after any DOM-changing action.** Labels reset on every `screenshot_mark` call. A label from before a click/scroll/navigation is invalid.

## Tools

| Tool | What it does |
|---|---|
| `screenshot_mark` | Capture + label. Args: `url?`, `wait_ms?`, `fullpage?`, `region?: {x,y,w,h}`, `detector?: "dom"\|"omniparser"`. |
| `click_label` | Click center of label N. |
| `type_at_label` | Focus label N and type. Optional `clear: true` for select-all + delete first. |
| `scroll` | Wheel `up` or `down` by `amount` pixels (default 500). |
| `find_label` | Rank the last screenshot's labels against a description ("submit button"). Returns top matches with scores. |
| `get_page_text` | Return page innerText, or one labeled element's text. Use this to read content instead of OCRing a screenshot. |
| `press_key` | Send a key: `"Enter"`, `"Escape"`, `"Tab"`, `"Meta+A"`. Faster than hunting for the submit button. |
| `hover_label` | Move mouse to label N without clicking. For hover-revealed menus. |
| `go_back` / `go_forward` | Browser history navigation. |
| `wait_for_load` | Wait for `load` \| `domcontentloaded` \| `networkidle`. |
| `upload_at_label` | Attach a file to label N. Handles both bare `<input type=file>` and buttons or links that open a **native OS file picker**. `path` takes a string or an array. Upload sequentially when slot order matters. |
| `run_javascript` | Evaluate JS in the page and get the result back. |
| `open_tab` / `switch_tab` / `list_tabs` / `close_tab` | Tab management. Every action tool takes an optional `tab_id` to act on a non-active tab. Popups and `target=_blank` register automatically. |
| `get_cookies` / `set_cookie` / `clear_cookies` | Cookie access. Shared across all tabs in the session. |
| `clear_profile` | Wipe the browser profile and restart clean. Logout-like. |

### `run_javascript` is not a last resort

On stateful SPA forms it is the primary tool, not an escape hatch. Use it to read what a screenshot cannot show you:

- Read the live `.value` of fields you did not just type into.
- Audit completeness, for example "which radio groups have nothing checked" across a multi-page wizard.
- Locate off-screen elements by text plus `getBoundingClientRect()`, which beats scrolling around hunting for a sticky footer button.
- Check validation state: error banner text, whether a modal is still open, whether a button is `disabled`.

Every action that can change the URL returns the resulting `url` in its response. No need to follow up with a screenshot just to confirm where you landed.

## Patterns that work

- **"Click submit"** → if you can read "Submit" on the labeled image, `click_label` that number. If not, `find_label "submit"` first.
- **"Search for X"** → screenshot_mark → `find_label "search"` → type_at_label N "X" → `press_key Enter` → `wait_for_load networkidle` → screenshot_mark to see results.
- **"Read the article"** → `get_page_text` with a generous `max_chars`. Don't try to OCR the screenshot or scroll-and-shoot the whole thing.
- **"Verify the previous fix worked"** → navigate, screenshot_mark, get_page_text for verification text. Far cheaper than visual inspection.

## Anti-patterns

- Don't carry label numbers across screenshots. They reset every `screenshot_mark` call. If you need to act again, re-screenshot.
- Don't fullpage-screenshot a long article to read it. `get_page_text` exists.
- Don't try to compute (x, y) yourself. Marksman owns the bbox math; you only pick labels.
- Don't ignore the URL returned by action tools. Confirming you landed where you expected saves a screenshot.

## Detector choice

- `dom` (default): fast (~10ms), reliable on standard web UIs (real DOM elements). What you want 95% of the time.
- `omniparser`: vision-based, ~1GB of weights, ~10-20s per inference on CPU. Switch to this only for canvas/WebGL UIs (Figma, Maps, Three.js apps) the DOM walker can't see. Requires running `scripts/setup-omniparser.sh` first.

Set the default in plugin config; override per-call by passing `detector: "omniparser"` to `screenshot_mark`.

## Headless or visible

By default Chromium runs headless. Toggle "Headless browser" off in plugin config to watch what marksman does. Useful when debugging a flow that's misbehaving.
