import type { Page } from "playwright";
import type { BBox, DetectedElement } from "./types.js";
import { suppressNested } from "./geometry.js";

/**
 * Walks the live DOM inside the page and returns a flat list of visible,
 * interactive elements with their viewport-relative bounding boxes.
 *
 * Done in-page (via evaluate) rather than via accessibility.snapshot() because
 * the a11y snapshot does not carry bounding boxes, and resolving them after
 * the fact through role+name lookups collides on any page with repeated
 * controls (nav menus, lists of buttons, etc.).
 */
export async function detectInteractiveElements(
  page: Page,
): Promise<DetectedElement[]> {
  const raw = await page.evaluate(() => {
    const SELECTOR = [
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "[role='button']",
      "[role='link']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='menuitem']",
      "[role='tab']",
      "[role='textbox']",
      "[role='combobox']",
      "[role='switch']",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])",
      "[onclick]",
      "summary",
      "label",
    ].join(",");

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const out: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      type: string;
      text: string;
    }> = [];

    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const candidateSet = new Set<Element>(nodes);

    // Drop wrapping <label> elements when their target is already labeled.
    // httpbin-style forms render <label>Text<input></label> or
    // <label for="x">Text</label><input id="x">; in both cases the <label>
    // itself isn't separately clickable for our purposes — clicking the input
    // (or its label text via implicit association) is what matters.
    const isRedundantLabel = (el: Element): boolean => {
      if (el.tagName.toLowerCase() !== "label") return false;
      const lbl = el as HTMLLabelElement;
      if (lbl.htmlFor) {
        const target = document.getElementById(lbl.htmlFor);
        if (target && candidateSet.has(target)) return true;
      }
      for (const desc of Array.from(lbl.querySelectorAll("*"))) {
        if (candidateSet.has(desc)) return true;
      }
      return false;
    };

    const seen = new Set<Element>();

    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (isRedundantLabel(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      // Skip elements completely outside the viewport. Negative coords or
      // beyond-viewport elements would land off the screenshot.
      if (
        rect.right < 0 ||
        rect.bottom < 0 ||
        rect.left > viewportW ||
        rect.top > viewportH
      ) {
        continue;
      }

      const style = window.getComputedStyle(el);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        style.opacity === "0" ||
        (el as HTMLElement).hidden
      ) {
        continue;
      }
      if ((el as HTMLInputElement).disabled) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const type = role ?? tag;

      const text = (
        (el as HTMLElement).innerText ??
        el.textContent ??
        ""
      ).trim();

      const ariaLabel =
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        el.getAttribute("placeholder") ??
        "";

      // Form controls (input/select/textarea/button) usually have their
      // human-readable text in an associated <label> via the .labels API.
      // Without this merge, checkboxes/radios end up with empty text and
      // find_label can't match them by description.
      let labelText = "";
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        labelText = Array.from(labels)
          .map((l) => (l as HTMLElement).innerText.trim())
          .filter(Boolean)
          .join(" ");
      }

      out.push({
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        type,
        text: text || labelText || ariaLabel,
      });
    }

    return out;
  });

  // Suppress elements whose bbox is more than 80% contained inside another
  // element's bbox — keeps the inner control, drops the wrapping container.
  const withBbox = raw.map((el) => ({
    bbox: { x: el.x, y: el.y, w: el.w, h: el.h } as BBox,
    type: el.type,
    text: el.text,
  }));
  const filtered = suppressNested(withBbox);

  return filtered.map((el, i) => ({
    label: i + 1,
    bbox: el.bbox,
    type: el.type,
    text: el.text,
    interactive: true, // DOM walker only emits elements from the interactive selector set
  }));
}
