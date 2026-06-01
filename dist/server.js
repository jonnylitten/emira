#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser } from "./browser.js";
import { getMarksman } from "./controller.js";
const server = new McpServer({ name: "marksman", version: "0.3.0" });
const m = getMarksman();
const RegionSchema = z
    .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
})
    .describe("Pixel rectangle in page coordinates to crop to.");
const TabIdField = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Act on a specific tab. Defaults to the active tab. Use list_tabs to see open tab ids; switch_tab to change the active one.");
server.tool("screenshot_mark", "Take a screenshot of the current page and return it with numbered labels over every interactive element. Always call before click_label / type_at_label — the label map is per-tab and rebuilt each call. Use `region` to zoom into a dense part of the page; `tab_id` to screenshot a non-active tab.", {
    url: z
        .string()
        .url()
        .optional()
        .describe("Optional. Navigate here before screenshotting."),
    wait_ms: z.number().int().nonnegative().optional(),
    fullpage: z.boolean().optional(),
    region: RegionSchema.optional(),
    detector: z
        .enum(["dom", "omniparser"])
        .optional()
        .describe("Override the default detector. 'dom' walks the live DOM (fast, no setup). 'omniparser' uses a visual model (catches canvas/WebGL UIs; requires Python sidecar — run scripts/setup-omniparser.sh first). Default comes from MARKSMAN_DETECTOR env, falling back to 'dom'."),
    interactive_only: z
        .boolean()
        .optional()
        .describe("Drop non-interactive detections (e.g., OmniParser's static text labels on maps) before labeling. Default: true for omniparser (cuts noise), false for dom (no-op)."),
    tab_id: TabIdField,
}, async (args) => {
    const { image, elements, url, detector, detect_ms, tab_id } = await m.screenshot(args);
    const summary = elements
        .slice(0, 40)
        .map((el) => `${el.label}: ${el.type}${el.text ? ` "${el.text.slice(0, 80)}"` : ""}`)
        .join("\n");
    return {
        content: [
            {
                type: "image",
                data: image.toString("base64"),
                mimeType: "image/png",
            },
            {
                type: "text",
                text: `Tab ${tab_id} | URL: ${url}\nDetector: ${detector} (${detect_ms}ms)\nFound ${elements.length} interactive elements.\n` +
                    summary +
                    (elements.length > 40
                        ? `\n…and ${elements.length - 40} more.`
                        : ""),
            },
        ],
    };
});
server.tool("click_label", "Click the element with the given label number from the most recent screenshot_mark on the same tab.", { label: z.number().int().positive(), tab_id: TabIdField }, async ({ label, tab_id }) => {
    const { x, y, url, tab_id: tid } = await m.click(label, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Clicked label ${label} at (${Math.round(x)}, ${Math.round(y)}). URL: ${url}`,
            },
        ],
    };
});
server.tool("type_at_label", "Focus the labeled element by clicking it, then type the given text. Use for inputs and textareas.", {
    label: z.number().int().positive(),
    text: z.string(),
    clear: z.boolean().optional(),
    tab_id: TabIdField,
}, async ({ label, text, clear, tab_id }) => {
    const { url, tab_id: tid } = await m.type(label, text, clear, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Typed ${text.length} chars at label ${label}. URL: ${url}`,
            },
        ],
    };
});
server.tool("upload_at_label", "Upload one or more files via a labeled file input or upload button. Works for direct <input type='file'> elements AND for buttons/links that open a file picker on click. `path` is an absolute path on the marksman host's filesystem. Pass an array for multi-file inputs.", {
    label: z.number().int().positive(),
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to wait for the file picker after clicking. Default: 5000ms."),
    tab_id: TabIdField,
}, async ({ label, path, timeout_ms, tab_id }) => {
    const { url, count, tab_id: tid } = await m.uploadAtLabel(label, path, timeout_ms, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Uploaded ${count} file${count === 1 ? "" : "s"} at label ${label}. URL: ${url}`,
            },
        ],
    };
});
server.tool("scroll", "Scroll the page up or down by a pixel amount.", {
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().optional(),
    tab_id: TabIdField,
}, async ({ direction, amount, tab_id }) => {
    const { url, tab_id: tid } = await m.scroll(direction, amount, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Scrolled ${direction} ${amount ?? 500}px. URL: ${url}`,
            },
        ],
    };
});
server.tool("find_label", "Rank labels from the most recent screenshot on this tab by how well they match a natural-language description. Returns top matches with scores. Use to pick a target by description ('the Submit button') without re-screenshotting. Returns empty if no element matches.", {
    description: z.string().min(1),
    limit: z.number().int().positive().optional(),
    tab_id: TabIdField,
}, async ({ description, limit, tab_id }) => {
    const matches = await m.findLabel(description, limit ?? 3, tab_id);
    if (matches.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No labels matched "${description}". Try screenshot_mark again or refine the description.`,
                },
            ],
        };
    }
    const lines = matches.map((mm) => `${mm.label} (${mm.type}, score ${mm.score}): "${mm.text}"`);
    return {
        content: [
            { type: "text", text: `Top matches:\n${lines.join("\n")}` },
        ],
    };
});
server.tool("press_key", "Send a keyboard key to the page. Accepts Playwright key strings: single chars ('a'), named keys ('Enter', 'Escape', 'Tab', 'ArrowDown'), or combos ('Meta+A', 'Control+L'). Use Enter to submit forms without finding the submit button.", { key: z.string().min(1), tab_id: TabIdField }, async ({ key, tab_id }) => {
    const { url, tab_id: tid } = await m.pressKey(key, tab_id);
    return {
        content: [
            { type: "text", text: `Tab ${tid} | Pressed ${key}. URL: ${url}` },
        ],
    };
});
server.tool("hover_label", "Move the mouse to the center of the labeled element without clicking. Use to reveal hover-only menus or tooltips, then screenshot_mark to see the new state.", { label: z.number().int().positive(), tab_id: TabIdField }, async ({ label, tab_id }) => {
    const { x, y, url, tab_id: tid } = await m.hoverLabel(label, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Hovered label ${label} at (${Math.round(x)}, ${Math.round(y)}). URL: ${url}`,
            },
        ],
    };
});
server.tool("go_back", "Navigate one step back in browser history (on the specified or active tab).", { tab_id: TabIdField }, async ({ tab_id }) => {
    const { ok, url, tab_id: tid } = await m.goBack(tab_id);
    return {
        content: [
            {
                type: "text",
                text: ok
                    ? `Tab ${tid} | Went back. URL: ${url}`
                    : `Tab ${tid} | No previous page in history. URL: ${url}`,
            },
        ],
    };
});
server.tool("go_forward", "Navigate one step forward in browser history (on the specified or active tab).", { tab_id: TabIdField }, async ({ tab_id }) => {
    const { ok, url, tab_id: tid } = await m.goForward(tab_id);
    return {
        content: [
            {
                type: "text",
                text: ok
                    ? `Tab ${tid} | Went forward. URL: ${url}`
                    : `Tab ${tid} | No forward page in history. URL: ${url}`,
            },
        ],
    };
});
server.tool("wait_for_load", "Wait for the page to reach a load state. Use after actions that trigger navigation or background fetches before the next screenshot.", {
    state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    timeout_ms: z.number().int().positive().optional(),
    tab_id: TabIdField,
}, async ({ state, timeout_ms, tab_id }) => {
    const { url, tab_id: tid } = await m.waitForLoad(state ?? "load", timeout_ms, tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Reached load state: ${state ?? "load"}. URL: ${url}`,
            },
        ],
    };
});
server.tool("run_javascript", "Run arbitrary JavaScript in the current page context — an escape hatch for things marksman doesn't have a dedicated tool for (read localStorage, dismiss a custom dialog, scroll an inner container, parse a DOM region). The `code` is a function body: use `return X` to send a value back. For Promise-returning code (fetch, IndexedDB, etc.), set `await_promise: true` and use `await` in the body. Result is JSON-serialized; non-serializable values become undefined. Logs each call to stderr for auditability.", {
    code: z
        .string()
        .min(1)
        .describe("A JavaScript function body. Use `return X` to send a value back. Examples: `return localStorage.getItem('user_id')`, `return document.querySelector('.error')?.textContent`, `document.querySelector('.modal-close')?.click()` (no return needed for side-effects)."),
    await_promise: z
        .boolean()
        .optional()
        .describe("Wrap the body in an async function so you can use `await` inside. Use for fetch, IndexedDB, etc. Default: false."),
    tab_id: TabIdField,
}, async ({ code, await_promise, tab_id }) => {
    const { result, url, tab_id: tid } = await m.runJavascript(code, await_promise, tab_id);
    const json = result === undefined ? "undefined" : JSON.stringify(result);
    const limit = 4000;
    const display = json.length > limit
        ? json.slice(0, limit) + `\n…[truncated, total ${json.length} chars]`
        : json;
    return {
        content: [
            {
                type: "text",
                text: `Tab ${tid} | Result: ${display}\nURL: ${url}`,
            },
        ],
    };
});
server.tool("clear_profile", "Wipe the persistent browser profile (cookies, localStorage, IndexedDB, downloads). The next screenshot will see a fresh browser as if you'd never logged into anything. Use for logout-like operations or to reset between unrelated automation runs. Closes all tabs as a side effect — the next action spawns a fresh single-tab session.", {}, async () => {
    const { profileDir } = await m.clearProfile();
    return {
        content: [
            {
                type: "text",
                text: `Profile cleared at ${profileDir}. Next action will spawn a fresh browser context with one tab.`,
            },
        ],
    };
});
server.tool("get_page_text", "Return the readable text of the current page (innerText of body), or the text of a single labeled element if `label` is given. Use to read content (search results, JSON responses, article body) without a screenshot.", {
    label: z.number().int().positive().optional(),
    max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate output to this many characters. Default: 4000."),
    main_content_only: z
        .boolean()
        .optional()
        .describe("Prefer <main> / <article> / [role=main] over <body>. Trims site chrome (nav, footer, donate banners). Heuristic — falls back to <body> if no semantic root is found."),
    tab_id: TabIdField,
}, async ({ label, max_chars, main_content_only, tab_id }) => {
    const text = await m.getPageText(label, main_content_only, tab_id);
    const limit = max_chars ?? 4000;
    const out = text.length > limit
        ? `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`
        : text;
    return { content: [{ type: "text", text: out }] };
});
// ─── Tab management tools ────────────────────────────────────────────────
server.tool("open_tab", "Open a new browser tab and make it the active tab. Pass `url` to navigate immediately, or omit to open a blank tab. Returns the new tab's id (use it with `tab_id` on other tools, or just keep working since it's now active).", {
    url: z.string().url().optional(),
    wait_ms: z.number().int().nonnegative().optional(),
}, async ({ url, wait_ms }) => {
    const { tab_id, url: landedUrl } = await m.openTab(url, wait_ms);
    return {
        content: [
            {
                type: "text",
                text: `Opened tab ${tab_id}. URL: ${landedUrl}`,
            },
        ],
    };
});
server.tool("switch_tab", "Change the active tab. Subsequent tools without `tab_id` will act on the new active tab. Use list_tabs to see options.", { tab_id: z.number().int().positive() }, async ({ tab_id }) => {
    const { url } = await m.switchTab(tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Switched to tab ${tab_id}. URL: ${url}`,
            },
        ],
    };
});
server.tool("list_tabs", "List all open tabs with their id, url, title, and which one is active. Popups (target=_blank clicks, window.open) are auto-registered, so use this after a click that opens a new window to find its id.", {}, async () => {
    const tabs = await m.listTabs();
    const lines = tabs.map((t) => `${t.active ? "▶" : " "} tab ${t.id}: ${t.title || "(untitled)"} — ${t.url}`);
    return {
        content: [
            { type: "text", text: lines.join("\n") || "(no tabs open)" },
        ],
    };
});
server.tool("close_tab", "Close a tab (defaults to active). If you close the last tab, a fresh blank one is opened automatically so the session stays usable.", { tab_id: TabIdField }, async ({ tab_id }) => {
    const { closed_id, active_id } = await m.closeTab(tab_id);
    return {
        content: [
            {
                type: "text",
                text: `Closed tab ${closed_id}. Active tab now: ${active_id ?? "(none)"}`,
            },
        ],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
const shutdown = async () => {
    await closeBrowser();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => {
    console.error("marksman fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map