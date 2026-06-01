import sharp from "sharp";
import { performance } from "node:perf_hooks";
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
  /**
   * Drop elements flagged as non-interactive before labeling. Cuts OmniParser's
   * static-text noise (place names on a map, etc.). No-op for the DOM detector
   * since it only ever returns interactive elements. Defaults to true for
   * omniparser, false for dom.
   */
  interactive_only?: boolean;
}

export interface ScreenshotResult {
  image: Buffer;
  elements: DetectedElement[];
  url: string;
  detector: DetectorName;
  /** Milliseconds spent in detect(), exposed so callers learn relative cost. */
  detect_ms: number;
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

    const fullBuf = await page.screenshot({
      type: "png",
      fullPage: Boolean(opts.fullpage),
    });

    const detectorName = opts.detector ?? defaultDetector();
    const r = opts.region;

    // Crop BEFORE detection when the detector reads from the screenshot
    // (omniparser). Saves 5–10× on OmniParser inference time when the caller
    // only wants a corner of the page. DOM detector ignores the screenshot
    // buffer (it queries the live page), so cropping there is post-detection.
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

    // When detection ran on a crop, coords come back relative to the crop —
    // translate them into page space so labelMap clicks land correctly.
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

    // DOM detector with region: detection happened on the live page, so coords
    // are already page-space — just filter to those intersecting the region.
    if (r && detectorName === "dom") {
      elements = elements.filter((el) => bboxIntersects(el.bbox, r));
    }

    // Interactive-only filter. Default is detector-dependent: OmniParser
    // returns lots of static text labels (place names, road labels) that
    // aren't clickable; default true cleans that up. DOM detector only ever
    // returns interactive elements so the flag is a no-op there.
    const interactiveOnly =
      opts.interactive_only ?? detectorName === "omniparser";
    if (interactiveOnly) {
      elements = elements.filter((el) => el.interactive);
    }

    // Build the annotated image. If the region cropped the output, shift
    // bboxes to crop-relative coords for the visual labels; click coords stay
    // in page space via labelMap.
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

    // Renumber sequentially after all filters.
    elements = elements.map((el, i) => ({ ...el, label: i + 1 }));
    annotationElements = annotationElements.map((el, i) => ({
      ...el,
      label: i + 1,
    }));

    this.labelMap = {};
    this.elements = elements;
    for (const el of elements) this.labelMap[el.label] = el.bbox;

    const marked = await annotateScreenshot(outputBuf, annotationElements);
    return {
      image: marked,
      elements,
      url: page.url(),
      detector: detectorName,
      detect_ms,
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

  async uploadAtLabel(
    label: number,
    files: string | string[],
    timeout_ms = 5000,
  ): Promise<{ url: string; count: number }> {
    const bbox = this.requireLabel(label);
    const page = await getPage();
    const fileList = Array.isArray(files) ? files : [files];
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;

    // First try: resolve the element at the bbox center. If it's an
    // <input type="file"> (directly, or via a <label for=...> we landed on),
    // call setInputFiles on it — that's the most reliable path, doesn't
    // depend on the click actually opening a system file picker.
    const inputHandle = await page.evaluateHandle(
      ([x, y]) => {
        let el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (
          el &&
          el.tagName === "LABEL" &&
          (el as HTMLLabelElement).htmlFor
        ) {
          el =
            (document.getElementById(
              (el as HTMLLabelElement).htmlFor,
            ) as HTMLElement | null) ?? el;
        }
        if (
          el &&
          el.tagName === "INPUT" &&
          (el as HTMLInputElement).type === "file"
        ) {
          return el;
        }
        return null;
      },
      [cx, cy] as const,
    );
    const isFileInput = await inputHandle.evaluate((el) => el !== null);

    if (isFileInput) {
      const element = inputHandle.asElement();
      if (element) {
        await element.setInputFiles(fileList as string[]);
        await inputHandle.dispose();
        return { url: page.url(), count: fileList.length };
      }
    }
    await inputHandle.dispose();

    // Fallback: click a button/link that opens a file dialog. Arm the
    // filechooser listener BEFORE the click — the event fires synchronously
    // with the click and can be missed otherwise.
    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: timeout_ms,
    });
    await page.mouse.click(cx, cy);
    let chooser;
    try {
      chooser = await fileChooserPromise;
    } catch (err) {
      throw new Error(
        `Label ${label} is neither a file input nor a control that opens a file picker within ${timeout_ms}ms. ` +
          `(orig: ${(err as Error).message})`,
      );
    }
    await chooser.setFiles(fileList);
    return { url: page.url(), count: fileList.length };
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

  async getPageText(
    label?: number,
    mainOnly: boolean = false,
  ): Promise<string> {
    if (label !== undefined) {
      const el = this.elements.find((e) => e.label === label);
      if (!el) throw new Error(`Label ${label} not found.`);
      return el.text;
    }
    const page = await getPage();
    if (mainOnly) {
      // Prefer semantic main-content roots over <body>. Saves ~300 chars of
      // Wikipedia-style nav/donate chrome that otherwise eats up max_chars.
      return await page.evaluate(() => {
        const main =
          document.querySelector("main") ??
          document.querySelector("article") ??
          document.querySelector('[role="main"]');
        return ((main ?? document.body) as HTMLElement).innerText;
      });
    }
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

async function ensureCropped(buf: Buffer, r: BBox): Promise<Buffer> {
  return await sharp(buf)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .png()
    .toBuffer();
}

let instance: Marksman | null = null;
export function getMarksman(): Marksman {
  if (!instance) instance = new Marksman();
  return instance;
}
