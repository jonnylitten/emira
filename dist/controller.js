import sharp from "sharp";
import { performance } from "node:perf_hooks";
import { getTabs, getContext, clearProfile, getProfileDir } from "./browser.js";
import { annotateScreenshot } from "./annotate.js";
import { scoreElements } from "./scoring.js";
import { bboxIntersects } from "./geometry.js";
import { assertEscalationAllowed, assertNavigable, assertUploadPath, fencePageContent, } from "./policy.js";
import { detect, defaultDetector, } from "./detector.js";
/**
 * Owns the active browser session's tab registry. Both the MCP server and the
 * HTTP server route through this class so action semantics stay identical
 * across surfaces.
 *
 * State (label maps, last detection results) is per-tab — each TabState owns
 * its own labelMap and elements list, scoped to that tab's most recent
 * screenshot. See ./tabs.ts.
 */
export class Marksman {
    async screenshot(opts = {}) {
        const tab = (await getTabs()).get(opts.tab_id);
        const { page } = tab;
        if (opts.url) {
            const target = assertNavigable(opts.url);
            await page
                .goto(target, { waitUntil: "networkidle", timeout: 15000 })
                .catch(async (err) => {
                if (/Timeout/i.test(err.message)) {
                    await page.goto(target, { waitUntil: "domcontentloaded" });
                }
                else
                    throw err;
            });
        }
        if (opts.wait_ms)
            await page.waitForTimeout(opts.wait_ms);
        // Heavy pages (large media uploaders, many webfonts) can hang a full-page
        // capture past the default timeout. Falling back to the viewport beats
        // failing the whole call, since the label map is what callers act on.
        const shotTimeout = Number(process.env.MARKSMAN_SHOT_TIMEOUT_MS ?? 15000);
        let fullBuf;
        try {
            fullBuf = await page.screenshot({
                type: "png",
                fullPage: Boolean(opts.fullpage),
                timeout: shotTimeout,
            });
        }
        catch (err) {
            if (!opts.fullpage)
                throw err;
            console.error(`[marksman] full-page capture failed (${err.message}); ` +
                `falling back to viewport capture`);
            fullBuf = await page.screenshot({
                type: "png",
                fullPage: false,
                timeout: shotTimeout,
            });
        }
        const detectorName = opts.detector ?? defaultDetector();
        const r = opts.region;
        const cropBeforeDetect = !!r && detectorName === "omniparser";
        const detectionBuf = cropBeforeDetect
            ? await sharp(fullBuf)
                .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
                .png()
                .toBuffer()
            : fullBuf;
        const t0 = performance.now();
        let elements = await detect(detectorName, {
            page,
            screenshot: detectionBuf,
        });
        const detect_ms = Math.round(performance.now() - t0);
        if (cropBeforeDetect && r) {
            elements = elements.map((el) => ({
                ...el,
                bbox: {
                    x: el.bbox.x + r.x,
                    y: el.bbox.y + r.y,
                    w: el.bbox.w,
                    h: el.bbox.h,
                },
            }));
        }
        if (r && detectorName === "dom") {
            elements = elements.filter((el) => bboxIntersects(el.bbox, r));
        }
        const interactiveOnly = opts.interactive_only ?? detectorName === "omniparser";
        if (interactiveOnly) {
            elements = elements.filter((el) => el.interactive);
        }
        const outputBuf = r ? await ensureCropped(fullBuf, r) : fullBuf;
        let annotationElements = elements;
        if (r) {
            annotationElements = elements.map((el) => ({
                ...el,
                bbox: {
                    x: el.bbox.x - r.x,
                    y: el.bbox.y - r.y,
                    w: el.bbox.w,
                    h: el.bbox.h,
                },
            }));
        }
        elements = elements.map((el, i) => ({ ...el, label: i + 1 }));
        annotationElements = annotationElements.map((el, i) => ({
            ...el,
            label: i + 1,
        }));
        // Per-tab label state — each tab's most recent screenshot has its own
        // labels, so switching tabs and acting doesn't accidentally hit a label
        // from the other tab.
        tab.labelMap = {};
        tab.elements = elements;
        for (const el of elements)
            tab.labelMap[el.label] = el.bbox;
        const marked = await annotateScreenshot(outputBuf, annotationElements);
        return {
            image: marked,
            elements,
            url: page.url(),
            detector: detectorName,
            detect_ms,
            tab_id: tab.id,
        };
    }
    async click(label, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        const bbox = this.requireLabel(tab, label);
        const x = bbox.x + bbox.w / 2;
        const y = bbox.y + bbox.h / 2;
        await tab.page.mouse.click(x, y);
        return { x, y, url: tab.page.url(), tab_id: tab.id };
    }
    async type(label, text, clear, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        const bbox = this.requireLabel(tab, label);
        await tab.page.mouse.click(bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
        if (clear) {
            await tab.page.keyboard.press("Meta+A");
            await tab.page.keyboard.press("Delete");
        }
        await tab.page.keyboard.type(text, { delay: 30 });
        return { url: tab.page.url(), tab_id: tab.id };
    }
    async scroll(direction, amount = 500, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        await tab.page.mouse.wheel(0, direction === "down" ? amount : -amount);
        return { url: tab.page.url(), tab_id: tab.id };
    }
    async findLabel(description, limit = 3, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        return scoreElements(tab.elements, description).slice(0, limit);
    }
    async pressKey(key, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        await tab.page.keyboard.press(key);
        return { url: tab.page.url(), tab_id: tab.id };
    }
    async uploadAtLabel(label, files, timeout_ms = 5000, tab_id) {
        assertEscalationAllowed("upload_at_label");
        const tab = (await getTabs()).get(tab_id);
        const bbox = this.requireLabel(tab, label);
        const { page } = tab;
        // Confine to MARKSMAN_UPLOAD_ROOT before anything touches the page.
        const fileList = (Array.isArray(files) ? files : [files]).map(assertUploadPath);
        const cx = bbox.x + bbox.w / 2;
        const cy = bbox.y + bbox.h / 2;
        const inputHandle = await page.evaluateHandle(([x, y]) => {
            let el = document.elementFromPoint(x, y);
            if (el &&
                el.tagName === "LABEL" &&
                el.htmlFor) {
                el =
                    document.getElementById(el.htmlFor) ?? el;
            }
            if (el &&
                el.tagName === "INPUT" &&
                el.type === "file") {
                return el;
            }
            return null;
        }, [cx, cy]);
        const isFileInput = await inputHandle.evaluate((el) => el !== null);
        if (isFileInput) {
            const element = inputHandle.asElement();
            if (element) {
                await element.setInputFiles(fileList);
                await inputHandle.dispose();
                return { url: page.url(), count: fileList.length, tab_id: tab.id };
            }
        }
        await inputHandle.dispose();
        const fileChooserPromise = page.waitForEvent("filechooser", {
            timeout: timeout_ms,
        });
        await page.mouse.click(cx, cy);
        let chooser;
        try {
            chooser = await fileChooserPromise;
        }
        catch (err) {
            throw new Error(`Label ${label} is neither a file input nor a control that opens a file picker within ${timeout_ms}ms. ` +
                `(orig: ${err.message})`);
        }
        await chooser.setFiles(fileList);
        return { url: page.url(), count: fileList.length, tab_id: tab.id };
    }
    async hoverLabel(label, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        const bbox = this.requireLabel(tab, label);
        const x = bbox.x + bbox.w / 2;
        const y = bbox.y + bbox.h / 2;
        await tab.page.mouse.move(x, y);
        return { x, y, url: tab.page.url(), tab_id: tab.id };
    }
    async goBack(tab_id) {
        const tab = (await getTabs()).get(tab_id);
        try {
            const resp = await tab.page.goBack({ waitUntil: "load" });
            return { ok: resp !== null, url: tab.page.url(), tab_id: tab.id };
        }
        catch {
            await tab.page.waitForLoadState("load").catch(() => { });
            return { ok: false, url: tab.page.url(), tab_id: tab.id };
        }
    }
    async goForward(tab_id) {
        const tab = (await getTabs()).get(tab_id);
        try {
            const resp = await tab.page.goForward({ waitUntil: "load" });
            return { ok: resp !== null, url: tab.page.url(), tab_id: tab.id };
        }
        catch {
            await tab.page.waitForLoadState("load").catch(() => { });
            return { ok: false, url: tab.page.url(), tab_id: tab.id };
        }
    }
    async waitForLoad(state = "load", timeout, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        await tab.page.waitForLoadState(state, timeout ? { timeout } : undefined);
        return { url: tab.page.url(), tab_id: tab.id };
    }
    async runJavascript(code, awaitPromise = false, tab_id) {
        assertEscalationAllowed("run_javascript");
        const tab = (await getTabs()).get(tab_id);
        const wrapped = awaitPromise
            ? `(async () => { ${code} })()`
            : `(() => { ${code} })()`;
        console.error(`[marksman] run_javascript${awaitPromise ? " (await)" : ""} (tab ${tab.id}): ${code.slice(0, 200)}${code.length > 200 ? "…" : ""}`);
        const result = await tab.page.evaluate(wrapped);
        return { result, url: tab.page.url(), tab_id: tab.id };
    }
    // ─── Cookie management ─────────────────────────────────────────────────
    // Cookies live on the BrowserContext (shared across all tabs), so these
    // don't take a tab_id — they always operate on the full context.
    async getCookies(urls) {
        assertEscalationAllowed("get_cookies");
        const context = await getContext();
        return await context.cookies(urls);
    }
    async setCookie(cookie) {
        assertEscalationAllowed("set_cookie");
        const context = await getContext();
        // Playwright requires either `url` OR (`domain` AND `path`). Default path
        // to "/" if domain is given without one.
        if (!cookie.url && cookie.domain && !cookie.path) {
            cookie = { ...cookie, path: "/" };
        }
        await context.addCookies([cookie]);
    }
    async clearCookies(filter) {
        assertEscalationAllowed("clear_cookies");
        const context = await getContext();
        // Playwright's clearCookies accepts an optional filter; passing nothing
        // clears everything for the context.
        await context.clearCookies(filter);
        return { cleared: true };
    }
    async clearProfile() {
        // Reset the persistent context — wipes cookies, localStorage, IndexedDB,
        // etc. The next getTabs() call rebuilds the registry with a fresh,
        // single-tab context.
        return await clearProfile();
    }
    profileDir() {
        return getProfileDir();
    }
    async getPageText(label, mainOnly = false, tab_id) {
        const tab = (await getTabs()).get(tab_id);
        if (label !== undefined) {
            const el = tab.elements.find((e) => e.label === label);
            if (!el)
                throw new Error(`Label ${label} not found in tab ${tab.id}.`);
            // For form controls the caller almost always wants the live value, not
            // the detected label/placeholder text. Resolve the element the same way a
            // click does (bbox centre) and read .value / .checked when applicable.
            const live = await tab.page.evaluate(({ x, y }) => {
                const node = document.elementFromPoint(x, y);
                if (!node)
                    return null;
                if (node instanceof HTMLInputElement) {
                    return node.type === "checkbox" || node.type === "radio"
                        ? String(node.checked)
                        : node.value;
                }
                if (node instanceof HTMLTextAreaElement)
                    return node.value;
                if (node instanceof HTMLSelectElement)
                    return node.value;
                return null;
            }, { x: el.bbox.x + el.bbox.w / 2, y: el.bbox.y + el.bbox.h / 2 });
            return live ?? el.text;
        }
        // Bulk page text is the main injection vector, so mark it as data rather
        // than instructions. Single-label reads above are returned unfenced: they
        // are a targeted read of one element the caller already chose, and wrapping
        // a form value in a block would obscure it. Stated in the threat model.
        const src = tab.page.url();
        if (mainOnly) {
            const text = await tab.page.evaluate(() => {
                const main = document.querySelector("main") ??
                    document.querySelector("article") ??
                    document.querySelector('[role="main"]');
                return (main ?? document.body).innerText;
            });
            return fencePageContent(text, src);
        }
        const body = await tab.page.evaluate(() => document.body.innerText);
        return fencePageContent(body, src);
    }
    // ─── Tab management ────────────────────────────────────────────────────
    async openTab(url, wait_ms) {
        const tabs = await getTabs();
        const tab = await tabs.open(url ? assertNavigable(url) : url, wait_ms);
        return { tab_id: tab.id, url: tab.page.url() };
    }
    async switchTab(tab_id) {
        const tabs = await getTabs();
        const tab = tabs.switch(tab_id);
        return { tab_id: tab.id, url: tab.page.url() };
    }
    async listTabs() {
        const tabs = await getTabs();
        return await tabs.list();
    }
    async closeTab(tab_id) {
        const tabs = await getTabs();
        return await tabs.close(tab_id);
    }
    // ───────────────────────────────────────────────────────────────────────
    requireLabel(tab, label) {
        const bbox = tab.labelMap[label];
        if (!bbox) {
            throw new Error(`Label ${label} not found in tab ${tab.id}. Call screenshot_mark first; the label map is per-tab and resets on each screenshot.`);
        }
        return bbox;
    }
}
async function ensureCropped(buf, r) {
    return await sharp(buf)
        .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
        .png()
        .toBuffer();
}
let instance = null;
export function getMarksman() {
    if (!instance)
        instance = new Marksman();
    return instance;
}
//# sourceMappingURL=controller.js.map