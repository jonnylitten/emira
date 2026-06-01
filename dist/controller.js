import sharp from "sharp";
import { performance } from "node:perf_hooks";
import { getTabs, clearProfile, getProfileDir } from "./browser.js";
import { annotateScreenshot } from "./annotate.js";
import { scoreElements } from "./scoring.js";
import { bboxIntersects } from "./geometry.js";
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
            await page
                .goto(opts.url, { waitUntil: "networkidle", timeout: 15000 })
                .catch(async (err) => {
                if (/Timeout/i.test(err.message)) {
                    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
                }
                else
                    throw err;
            });
        }
        if (opts.wait_ms)
            await page.waitForTimeout(opts.wait_ms);
        const fullBuf = await page.screenshot({
            type: "png",
            fullPage: Boolean(opts.fullpage),
        });
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
        const tab = (await getTabs()).get(tab_id);
        const bbox = this.requireLabel(tab, label);
        const { page } = tab;
        const fileList = Array.isArray(files) ? files : [files];
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
        const tab = (await getTabs()).get(tab_id);
        const wrapped = awaitPromise
            ? `(async () => { ${code} })()`
            : `(() => { ${code} })()`;
        console.error(`[marksman] run_javascript${awaitPromise ? " (await)" : ""} (tab ${tab.id}): ${code.slice(0, 200)}${code.length > 200 ? "…" : ""}`);
        const result = await tab.page.evaluate(wrapped);
        return { result, url: tab.page.url(), tab_id: tab.id };
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
            return el.text;
        }
        if (mainOnly) {
            return await tab.page.evaluate(() => {
                const main = document.querySelector("main") ??
                    document.querySelector("article") ??
                    document.querySelector('[role="main"]');
                return (main ?? document.body).innerText;
            });
        }
        return await tab.page.evaluate(() => document.body.innerText);
    }
    // ─── Tab management ────────────────────────────────────────────────────
    async openTab(url, wait_ms) {
        const tabs = await getTabs();
        const tab = await tabs.open(url, wait_ms);
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