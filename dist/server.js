#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser } from "./browser.js";
import { getMarksman } from "./controller.js";
const server = new McpServer({ name: "marksman", version: "0.2.0" });
const m = getMarksman();
const RegionSchema = z
    .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
})
    .describe("Pixel rectangle in page coordinates to crop to.");
server.tool("screenshot_mark", "Take a screenshot of the current page and return it with numbered labels over every interactive element. Always call before click_label / type_at_label — the label map is rebuilt each call and stale after any DOM change. Use `region` to zoom into a dense part of the page.", {
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
}, async (args) => {
    const { image, elements, url, detector, detect_ms } = await m.screenshot(args);
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
                text: `URL: ${url}\nDetector: ${detector} (${detect_ms}ms)\nFound ${elements.length} interactive elements.\n` +
                    summary +
                    (elements.length > 40
                        ? `\n…and ${elements.length - 40} more.`
                        : ""),
            },
        ],
    };
});
server.tool("click_label", "Click the element with the given label number from the most recent screenshot_mark call.", { label: z.number().int().positive() }, async ({ label }) => {
    const { x, y, url } = await m.click(label);
    return {
        content: [
            {
                type: "text",
                text: `Clicked label ${label} at (${Math.round(x)}, ${Math.round(y)}). URL: ${url}`,
            },
        ],
    };
});
server.tool("type_at_label", "Focus the labeled element by clicking it, then type the given text. Use for inputs and textareas.", {
    label: z.number().int().positive(),
    text: z.string(),
    clear: z.boolean().optional(),
}, async ({ label, text, clear }) => {
    const { url } = await m.type(label, text, clear);
    return {
        content: [
            {
                type: "text",
                text: `Typed ${text.length} chars at label ${label}. URL: ${url}`,
            },
        ],
    };
});
server.tool("upload_at_label", "Upload one or more files via a labeled file input or upload button. Works for direct <input type='file'> elements AND for buttons/links that open a file picker on click — the tool arms a Playwright filechooser listener BEFORE clicking so either pattern works. `path` is an absolute path on the marksman host's filesystem. Pass an array for multi-file inputs.", {
    label: z.number().int().positive(),
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to wait for the file picker after clicking. Default: 5000ms."),
}, async ({ label, path, timeout_ms }) => {
    const { url, count } = await m.uploadAtLabel(label, path, timeout_ms);
    return {
        content: [
            {
                type: "text",
                text: `Uploaded ${count} file${count === 1 ? "" : "s"} at label ${label}. URL: ${url}`,
            },
        ],
    };
});
server.tool("scroll", "Scroll the page up or down by a pixel amount.", {
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().optional(),
}, async ({ direction, amount }) => {
    const { url } = await m.scroll(direction, amount);
    return {
        content: [
            {
                type: "text",
                text: `Scrolled ${direction} ${amount ?? 500}px. URL: ${url}`,
            },
        ],
    };
});
server.tool("find_label", "Rank labels from the most recent screenshot by how well they match a natural-language description. Returns top matches with scores. Use to pick a target by description ('the Submit button') without re-screenshotting. Returns empty if no element matches.", {
    description: z.string().min(1),
    limit: z.number().int().positive().optional(),
}, async ({ description, limit }) => {
    const matches = m.findLabel(description, limit ?? 3);
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
server.tool("press_key", "Send a keyboard key to the page. Accepts Playwright key strings: single chars ('a'), named keys ('Enter', 'Escape', 'Tab', 'ArrowDown'), or combos ('Meta+A', 'Control+L'). Use Enter to submit forms without finding the submit button.", { key: z.string().min(1) }, async ({ key }) => {
    const { url } = await m.pressKey(key);
    return {
        content: [{ type: "text", text: `Pressed ${key}. URL: ${url}` }],
    };
});
server.tool("hover_label", "Move the mouse to the center of the labeled element without clicking. Use to reveal hover-only menus or tooltips, then screenshot_mark to see the new state.", { label: z.number().int().positive() }, async ({ label }) => {
    const { x, y, url } = await m.hoverLabel(label);
    return {
        content: [
            {
                type: "text",
                text: `Hovered label ${label} at (${Math.round(x)}, ${Math.round(y)}). URL: ${url}`,
            },
        ],
    };
});
server.tool("go_back", "Navigate one step back in browser history.", {}, async () => {
    const { ok, url } = await m.goBack();
    return {
        content: [
            {
                type: "text",
                text: ok
                    ? `Went back. URL: ${url}`
                    : `No previous page in history. URL: ${url}`,
            },
        ],
    };
});
server.tool("go_forward", "Navigate one step forward in browser history.", {}, async () => {
    const { ok, url } = await m.goForward();
    return {
        content: [
            {
                type: "text",
                text: ok
                    ? `Went forward. URL: ${url}`
                    : `No forward page in history. URL: ${url}`,
            },
        ],
    };
});
server.tool("wait_for_load", "Wait for the page to reach a load state. Use after actions that trigger navigation or background fetches before the next screenshot.", {
    state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    timeout_ms: z.number().int().positive().optional(),
}, async ({ state, timeout_ms }) => {
    const { url } = await m.waitForLoad(state ?? "load", timeout_ms);
    return {
        content: [
            {
                type: "text",
                text: `Reached load state: ${state ?? "load"}. URL: ${url}`,
            },
        ],
    };
});
server.tool("clear_profile", "Wipe the persistent browser profile (cookies, localStorage, IndexedDB, downloads). The next screenshot will see a fresh browser as if you'd never logged into anything. Use for logout-like operations or to reset between unrelated automation runs. The profile directory itself stays — only its contents are cleared.", {}, async () => {
    const { profileDir } = await m.clearProfile();
    return {
        content: [
            {
                type: "text",
                text: `Profile cleared at ${profileDir}. Next action will spawn a fresh browser context.`,
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
}, async ({ label, max_chars, main_content_only }) => {
    const text = await m.getPageText(label, main_content_only);
    const limit = max_chars ?? 4000;
    const out = text.length > limit
        ? `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`
        : text;
    return { content: [{ type: "text", text: out }] };
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