# Field Report: Driving an App Store Connect submission with emira

**Date:** 2026-07-22
**Task:** Submit a universal app ("Type Weakness") to the iOS App Store: attach build, upload screenshots, fill per-version metadata, set App Review info, submit for review, and answer newly added age-rating questions.
**Outcome:** Full submission completed end to end through emira. The only step outside the browser was the Xcode archive and upload, which is a native app. The submission reached "Waiting for Review."

This is a real-world stress test. App Store Connect is a heavy React SPA with modals, file uploads, multi-step wizards, cross-field validation, and per-device screenshot slots. Below is what worked, what hurt, and what changed as a result.

> **Status note:** this report drove a round of fixes. Each pain point below carries its current status. Findings 1, 2, and 5 are fixed. Findings 3 and 4 remain open with documented guidance.

> **On the escalation gate:** this run leaned heavily on `run_javascript` and `upload_at_label`, both of which are now off by default (see README, "Security and threat model"). That is not a contradiction. Driving App Store Connect is precisely the case the gate is designed to permit: a target you chose, authenticated as yourself, deliberately. Set `EMIRA_ALLOW_ESCALATED=1` and point `EMIRA_UPLOAD_ROOT` at the folder holding your screenshots, or flip the equivalent toggles in plugin config. The gate exists for the opposite situation, where an agent is reading pages you did not choose and a page could induce those same calls.

---

## Summary

emira drove a stateful, upload-heavy flow start to finish. The core interaction model (set-of-marks plus `type_at_label` plus `upload_at_label`) covered the common cases, and `run_javascript` made the hard cases tractable: multi-step wizards, cross-field validation, and reading form values.

The rough edges were almost entirely around full-page screenshots and viewport sizing, not the interaction primitives.

---

## What worked

### `run_javascript` carried the submission

Concrete uses:

- **Read form values** the visual layer could not expose (`keywords`, `supportUrl`, `copyright` on the macOS version, to copy across to iOS).
- **Locate off-screen elements** by text plus `getBoundingClientRect()`, which found the sticky "Submit for Review" button at y=736 without hunting for it.
- **Audit form completeness**: "which radio groups have nothing checked" across a seven-step wizard. This is not reliably answerable from a screenshot.
- **Drive a loop**: click Next until it disappears, checking each page for unanswered questions.
- **Detect validation state**: read the error banner text, check whether a modal was still open, confirm a button's `disabled` state.

Calling this an escape hatch undersells it. For stateful SPA forms it is the primary tool.

### `upload_at_label` handled native file pickers

This is the thing most browser automation cannot do. App Store Connect uses "Choose File" controls that open a **native OS file picker**, not a bare `<input type=file>`, and emira handled it transparently. Single-file and multi-file both worked.

### Set-of-marks labeling and `type_at_label`

- `type_at_label` with `clear: true` filled every field correctly, **including React-controlled inputs**. The `onChange` registered and the form recognized the change. This is the usual failure mode of naive automation.
- `click_label` was reliable for buttons, tabs, and radios once given a fresh screenshot.

### `region` screenshots

Fast and reliable. These became the workhorse for reading the page.

---

## Pain points

### 1. Full-page `screenshot_mark` timed out repeatedly

**Status: fixed.** Captures now take an explicit timeout (`EMIRA_SHOT_TIMEOUT_MS`, default 15s) and fall back to a viewport capture instead of failing the call.

`page.screenshot: Timeout 30000ms exceeded`. Logs showed fonts loading and then the capture hanging. This happened consistently on the version page, which is long and carries a heavy media-uploader component, and got worse when the browser window was backgrounded (macOS throttling). `region` screenshots always worked, so the entire submission was done with cropped captures.

### 2. Small viewport

**Status: fixed.** The default viewport is now 1440x900 and is configurable via `EMIRA_VIEWPORT`.

The page rendered around 1000px wide inside a much larger window, leaving dead space and clipping content oddly. This likely contributed to the screenshot timeouts as well.

### 3. Batch upload scrambled file order

**Status: open, with guidance.** Upload files one at a time when slot order matters.

Uploading four screenshots as a single array landed them in async-completion order rather than array order. App Store Connect displays screenshots in slot order, so this matters. Uploading sequentially, letting each complete before starting the next, preserved order perfectly.

The cause is not emira. `uploadAtLabel` makes a single `setInputFiles(files)` call, and Playwright sets the FileList in array order deterministically. What reorders things is App Store Connect's own uploader reading that FileList and firing concurrent requests, slotting each screenshot as it completes. `setInputFiles` returns as soon as the files are set, so there is no point at which emira could wait.

**Before anyone writes a sequential-upload helper, know this:** `setInputFiles` *replaces* the FileList, it does not append. On a plain `<input multiple>`, four sequential calls leave you with only the fourth file. Sequential upload worked here because App Store Connect's uploader consumes each file and clears the input between selections, which is a property of that uploader and not of file inputs in general. A helper that loops must assert the file count actually increased after each call and fail loudly if it did not, rather than silently dropping files.

### 4. Labels renumber across re-renders

**Status: open by design, mitigation documented.**

Labels are assigned per screenshot, so after any DOM change (dialog open, tab switch, SPA route change) the map must be refreshed before acting. On a flow with this many state transitions that is a lot of round-trips. A stable handle keyed to a hashed selector would help, and is worth exploring, but re-screenshotting after every mutation is currently the correct discipline. `find_label` helps but still needs a recent screenshot.

### 5. `get_page_text(label)` returned label text, not the input's value

**Status: fixed.** For form controls it now returns the live `.value`, and `.checked` for checkboxes and radios.

Previously, calling it on an input returned the field's label or placeholder ("Description") rather than what was typed, so reading values meant dropping into `run_javascript`.

---

## What a complex target actually looks like

Useful context for anyone pointing emira at something similar:

- **Native file picker uploads** are central to App Store Connect.
- **Multi-step wizards validate across pages.** The age-rating questionnaire is roughly seven pages with Back and Next, and it validates combinations spanning pages. Answering "Social Media disabled for under-13 = Yes" while "Social Media = No" throws "Go back to Step 1." Recovering meant clicking Back six times to the right step and fixing a single radio, which was a clean `run_javascript` loop.
- **Sticky footer buttons** such as the real "Submit for Review" sit below the fold. Locating them by text through `run_javascript` beat scrolling around looking for them.
- **SPA sidebar navigation** sometimes did not route on `click_label` (the URL did not change). Clicking an in-content link, or navigating directly by URL, was more reliable.

---

## Remaining wishlist

1. Higher-level form helpers built on `run_javascript`: surface blank required fields, click by text without a screenshot round-trip, dump `{name: value}` for a container.
2. Stable element handles that survive re-renders (finding 4).
3. Runtime viewport control, in addition to the launch-time setting.

---

## Bottom line

emira drove a real, high-stakes, multi-modal App Store Connect submission: build attach, eight screenshots across two device slots, per-version metadata, App Review contact, submission, and a post-submission age-rating fix. The interaction model is sound. The friction was concentrated in screenshots and viewport, which were also the most fixable parts, and have since been fixed.
