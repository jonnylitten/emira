import sharp from "sharp";
import { getPage } from "./browser.js";
import { annotateScreenshot } from "./annotate.js";
import { scoreElements, type ScoredMatch } from "./scoring.js";
import { bboxIntersects } from "./geometry.js";
import {
  detect,
  defaultDetector,
  type DetectorName,
} from "./detector.js";
import type { BBox, DetectedElement, LabelMap } from "./types.js";

export interface ScreenshotOptions {
  url?: string;
  wait_ms?: number;
  fullpage?: boolean;
  region?: BBox;
  detector?: DetectorName;
}

export interface ScreenshotResult {
  image: Buffer;
  elements: DetectedElement[];
  url: string;
  detector: DetectorName;
}

/**
 * Owns the active browser session's label state. Both the MCP server and the
 * HTTP server route through this class so action semantics stay identical
 * across surfaces.
 *
 * Singleton for now — multi-tab support will eventually subdivide this.
 */
export class Marksman {
  private labelMap: LabelMap = {};
  private elements: DetectedElement[] = [];

  async screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const page = await getPage();

    if (opts.url) {
      await page
        .goto(opts.url, { waitUntil: "networkidle", timeout: 15000 })
        .catch(async (err: Error) => {
          if (/Timeout/i.test(err.message)) {
            await page.goto(opts.url!, { waitUntil: "domcontentloaded" });
          } else throw err;
        });
    }
    if (opts.wait_ms) await page.waitForTimeout(opts.wait_ms);

    let buf = await page.screenshot({
      type: "png",
      fullPage: Boolean(opts.fullpage),
    });

    const detectorName = opts.detector ?? defaultDetector();
    let elements = await detect(detectorName, { page, screenshot: buf });

    // Region cropping: filter elements to those intersecting the region,
    // crop the image to the region, and shift bboxes to region-relative for
    // annotation. Click coords stay in page space (the labelMap holds the
    // original bbox); only the annotated image uses shifted coords.
    let annotationElements = elements;
    if (opts.region) {
      const r = opts.region;
      elements = elements.filter((el) => bboxIntersects(el.bbox, r));
      buf = await sharp(buf)
        .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
        .png()
        .toBuffer();
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

    // Renumber sequentially after filtering.
    elements = elements.map((el, i) => ({ ...el, label: i + 1 }));
    annotationElements = annotationElements.map((el, i) => ({
      ...el,
      label: i + 1,
    }));

    this.labelMap = {};
    this.elements = elements;
    for (const el of elements) this.labelMap[el.label] = el.bbox;

    const marked = await annotateScreenshot(buf, annotationElements);
    return {
      image: marked,
      elements,
      url: page.url(),
      detector: detectorName,
    };
  }

  async click(label: number): Promise<{ x: number; y: number; url: string }> {
    const bbox = this.requireLabel(label);
    const page = await getPage();
    const x = bbox.x + bbox.w / 2;
    const y = bbox.y + bbox.h / 2;
    await page.mouse.click(x, y);
    return { x, y, url: page.url() };
  }

  async type(
    label: number,
    text: string,
    clear?: boolean,
  ): Promise<{ url: string }> {
    const bbox = this.requireLabel(label);
    const page = await getPage();
    await page.mouse.click(bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
    if (clear) {
      await page.keyboard.press("Meta+A");
      await page.keyboard.press("Delete");
    }
    await page.keyboard.type(text, { delay: 30 });
    return { url: page.url() };
  }

  async scroll(
    direction: "up" | "down",
    amount = 500,
  ): Promise<{ url: string }> {
    const page = await getPage();
    await page.mouse.wheel(0, direction === "down" ? amount : -amount);
    return { url: page.url() };
  }

  findLabel(description: string, limit = 3): ScoredMatch[] {
    return scoreElements(this.elements, description).slice(0, limit);
  }

  async pressKey(key: string): Promise<{ url: string }> {
    const page = await getPage();
    await page.keyboard.press(key);
    return { url: page.url() };
  }

  async hoverLabel(
    label: number,
  ): Promise<{ x: number; y: number; url: string }> {
    const bbox = this.requireLabel(label);
    const page = await getPage();
    const x = bbox.x + bbox.w / 2;
    const y = bbox.y + bbox.h / 2;
    await page.mouse.move(x, y);
    return { x, y, url: page.url() };
  }

  async goBack(): Promise<{ ok: boolean; url: string }> {
    const page = await getPage();
    try {
      const resp = await page.goBack({ waitUntil: "load" });
      return { ok: resp !== null, url: page.url() };
    } catch {
      // A click that triggered navigation can leave goBack racing against the
      // detached previous frame. Settle, then report current state.
      await page.waitForLoadState("load").catch(() => {});
      return { ok: false, url: page.url() };
    }
  }

  async goForward(): Promise<{ ok: boolean; url: string }> {
    const page = await getPage();
    try {
      const resp = await page.goForward({ waitUntil: "load" });
      return { ok: resp !== null, url: page.url() };
    } catch {
      await page.waitForLoadState("load").catch(() => {});
      return { ok: false, url: page.url() };
    }
  }

  async waitForLoad(
    state: "load" | "domcontentloaded" | "networkidle" = "load",
    timeout?: number,
  ): Promise<{ url: string }> {
    const page = await getPage();
    await page.waitForLoadState(state, timeout ? { timeout } : undefined);
    return { url: page.url() };
  }

  async getPageText(label?: number): Promise<string> {
    if (label !== undefined) {
      const el = this.elements.find((e) => e.label === label);
      if (!el) throw new Error(`Label ${label} not found.`);
      return el.text;
    }
    const page = await getPage();
    return await page.evaluate(() => document.body.innerText);
  }

  private requireLabel(label: number): BBox {
    const bbox = this.labelMap[label];
    if (!bbox) {
      throw new Error(
        `Label ${label} not found. Call screenshot first; the label map is reset on each screenshot.`,
      );
    }
    return bbox;
  }
}

let instance: Marksman | null = null;
export function getMarksman(): Marksman {
  if (!instance) instance = new Marksman();
  return instance;
}
