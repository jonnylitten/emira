# Emira

Set-of-Marks browser control for Claude Code. After you install this plugin, Claude can drive a real Chromium browser — clicking buttons, filling forms, reading pages — by picking numbered labels off a screenshot rather than fragile (x, y) coordinates.

```
> open https://github.com/login and sign me in as alice@example.com
```

Claude will screenshot the page, see "1: input 'Username'" and "2: input 'Password'" overlaid on the live form, then `type_at_label` and `click_label` its way through.

## Install

```bash
# Add this repo as a local marketplace, then install
claude plugin marketplace add /path/to/emira
claude plugin install emira@emira
```

On first session a `SessionStart` hook installs Node deps (Playwright, sharp, MCP SDK) into `~/.claude/plugins/data/emira-emira/` and downloads the Chromium binary. ~30s once; subsequent sessions are instant.

To try it for a single session without installing:

```bash
claude --plugin-dir /path/to/emira
```

## What you get

Eleven MCP tools, auto-loaded:

| Tool | What it does |
|---|---|
| `screenshot_mark` | Take a labeled screenshot. Optional: `url`, `wait_ms`, `fullpage`, `region`, `detector`. |
| `click_label` | Click center of label N. |
| `type_at_label` | Focus label N and type (optional `clear: true`). |
| `scroll` | Wheel scroll up/down. |
| `find_label` | Rank labels by natural-language description ("the submit button"). |
| `get_page_text` | Dump page innerText without a screenshot — for reading content. |
| `press_key` | `"Enter"`, `"Escape"`, `"Tab"`, `"Meta+A"`, etc. |
| `hover_label` | For hover-revealed menus. |
| `go_back` / `go_forward` | Browser history. |
| `wait_for_load` | Wait for `load` / `domcontentloaded` / `networkidle`. |

Every action that can change the URL returns the resulting URL — no follow-up screenshot just to confirm where you landed.

The plugin also ships a `SKILL.md` that tells Claude *when* to reach for these tools and the patterns that work well.

## Configure

```
/plugin configure emira@emira
```

| Option | Default | What |
|---|---|---|
| `detector` | `dom` | `dom` (fast DOM walker, works for standard web UIs) or `omniparser` (vision-based, catches canvas/WebGL apps like Figma). |
| `omniparser_path` | — | Absolute path to a cloned `microsoft/OmniParser` repo. Only needed when `detector=omniparser`. |
| `headless` | `true` | Turn off to watch what emira does in a visible window. |

Per-call override of the detector is also available — pass `detector: "omniparser"` to `screenshot_mark` for a single screenshot without changing the default.

## Optional: enable the OmniParser detector

The default DOM detector handles 95% of sites cleanly. For canvas/WebGL UIs (Figma, Google Maps, Three.js apps) you can switch to vision-based detection:

```bash
bash /path/to/emira/scripts/setup-omniparser.sh    # ~15–60 min, ~1GB of weights
```

Then set the `omniparser_path` plugin option to the cloned repo path, and `detector` to `omniparser`.

## Updating

This is a local-path marketplace, so updates are version-bumped:

```bash
# In the emira repo: bump version in .claude-plugin/plugin.json, then:
claude plugin update emira@emira
```

If you want every commit to count as a new version (faster iteration), remove the `version` field from `plugin.json` — Claude Code falls back to the git commit SHA.

## Troubleshoot

| Symptom | Try |
|---|---|
| Tools don't appear in a new session | `claude plugin list` — confirm `emira@emira` is enabled. |
| First screenshot is very slow | First session installs Playwright's Chromium (~150MB) and on the omniparser detector loads the model (~15-20s on CPU). One-time per machine / per session. |
| "Label N not found" error | The label map resets on every `screenshot_mark`. Re-screenshot before the next click. |
| Browser opens visibly when you want headless | `/plugin configure emira@emira` and toggle `headless` back to true. |
| OmniParser sidecar fails to start | Run `bash scripts/setup-omniparser.sh` first; ensure `omniparser_path` plugin option points at the cloned repo. |

## Uninstall

```bash
claude plugin uninstall emira@emira           # drops data dir by default
claude plugin marketplace remove emira           # unregister the marketplace
```

---

For development docs (architecture, HTTP server, test suite, contributing), see the root `README.md`.
