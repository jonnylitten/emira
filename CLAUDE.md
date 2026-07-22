# Marksman

Marksman is an MCP server that gives you vision-based browser control via Set-of-Marks labeling. It takes a screenshot, overlays numbered labels on every interactive element, and lets you act by label number rather than coordinates.

## When to reach for marksman

Use marksman when you need to interact with a web page: filling forms, clicking buttons, navigating flows, extracting content. Prefer it over writing Playwright scripts for one-off or exploratory tasks.

## Core loop

Every interaction follows this pattern:

1. Call `screenshot_mark` (with a URL to navigate, or without to capture the current page)
2. **Read the marked PNG** using the Read tool. The image is where the information is. The `labels` metadata alone is often empty for form inputs.
3. Decide which label to act on
4. Act (`click_label`, `type_at_label`, `press_key`, etc.)
5. **Re-screenshot before the next action**: label numbers reset after any DOM change (click, navigation, scroll past new content)

Never chain actions without re-screenshotting in between. Stale labels will either error or hit the wrong element.

## Tool quick reference

| Tool | When to use |
|---|---|
| `screenshot_mark` | Start of every interaction sequence, and after any action that changes the page |
| `click_label N` | Click a button, link, or control |
| `type_at_label N "text"` | Fill a form field (focuses the element first) |
| `find_label "description"` | When you know what you're looking for but not which number it is: "the submit button", "the email field" |
| `press_key "Enter"` | Submit forms (faster than finding the submit button) |
| `press_key "Tab"` | Move between fields |
| `get_page_text` | Read page content without a screenshot. Use for verification, JSON responses, article text |
| `scroll down` | When elements are below the fold. Re-screenshot after |
| `hover_label N` | Reveal hover menus before screenshotting |
| `go_back` / `go_forward` | Browser navigation |
| `wait_for_load` | After navigation that doesn't settle automatically |
| `upload_at_label N "path"` | Attach a file. Works with native OS file pickers, not just `<input type=file>`. Upload one at a time when order matters |
| `run_javascript` | Read live field values, audit unanswered required fields, locate off-screen elements, check validation state. Reach for it on stateful SPA forms rather than treating it as a last resort |
| `open_tab` / `switch_tab` / `list_tabs` / `close_tab` | Multi-tab work. Every action tool takes an optional `tab_id` |
| `get_cookies` / `set_cookie` / `clear_cookies` | Session state without going through a login flow |
| `clear_profile` | Wipe the profile and start clean (logout-like) |

## Practical patterns

**Filling a form:**
```
screenshot_mark <url>
# read the image, identify field labels
find_label "email"          # get the label number
type_at_label N "value"
# re-screenshot
find_label "password"
type_at_label N "value"
# re-screenshot
press_key "Enter"           # submit
```

**Verifying a result:**
```
# after form submission
get_page_text               # read the response without a screenshot round-trip
```

**Dense pages:**
```
screenshot_mark url region={"x":0,"y":200,"w":800,"h":400}   # crop to relevant area
```

**Animations or deferred content:**
```
screenshot_mark url wait_ms=2000    # wait 2s after navigation before capturing
```

**Full page (shorter pages):**
```
screenshot_mark url fullpage=true   # avoids scroll-then-mark for shorter pages
```

## Detector guidance

- **DOM (default):** Use for all standard web UIs: forms, buttons, links, inputs. Fast (~10ms). This covers Greenhouse, Lever, Ashby, LinkedIn, and most job application forms.
- **OmniParser:** Only switch for canvas/WebGL UIs (Figma, Google Maps, games). Much slower (~15-20s first load on CPU). Enable with `detector="omniparser"` per call, or `MARKSMAN_DETECTOR=omniparser` for the whole session.

**Auto-escalation heuristic:** If the DOM detector returns fewer elements than the page complexity suggests, or if elements clearly visible in the marked image aren't labeled, re-run `screenshot_mark` with `detector="omniparser"`. Signs that escalation is needed: a rich interactive UI with only 0-2 labels, map or canvas elements with no labels, buttons or controls visible in the image but absent from the label list.

## Common mistakes

- **Acting on stale labels**: always re-screenshot after any click or navigation
- **Skipping the image read**: `labels` metadata has no text for most form inputs; the image is essential
- **Using OmniParser for standard forms**: slower and noisier than DOM for HTML UIs
- **Chaining multiple actions without re-screenshotting**: label 5 after a click is not the same element as label 5 before it

## HTTP surface (for scripts and Pigeon)

Marksman also runs as an HTTP server on `:17542`:

```bash
node /Users/jkl/code/marksman/dist/http-server.js
```

Pigeon's `applicator/filler.ts` talks to this surface. Screenshots are saved to `/tmp/marksman/` as PNGs. Read them by path rather than shuttling base64.
