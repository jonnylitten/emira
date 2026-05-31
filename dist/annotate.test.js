import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { annotateScreenshot } from "./annotate.js";
async function blankPng(width, height) {
    return sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
        },
    })
        .png()
        .toBuffer();
}
function el(label, x, y, w, h, text = "btn") {
    return {
        label,
        bbox: { x, y, w, h },
        type: "button",
        text,
        interactive: true,
    };
}
describe("annotateScreenshot", () => {
    it("returns a valid PNG with the original dimensions", async () => {
        const base = await blankPng(800, 600);
        const out = await annotateScreenshot(base, []);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(800);
        expect(meta.height).toBe(600);
        expect(meta.format).toBe("png");
    });
    it("produces visibly different bytes when elements are drawn", async () => {
        const base = await blankPng(400, 300);
        const empty = await annotateScreenshot(base, []);
        const drawn = await annotateScreenshot(base, [el(1, 50, 50, 100, 40)]);
        expect(drawn.equals(empty)).toBe(false);
    });
    it("handles many elements without throwing", async () => {
        const base = await blankPng(1200, 800);
        const many = Array.from({ length: 60 }, (_, i) => el(i + 1, (i % 10) * 100, Math.floor(i / 10) * 60, 80, 40));
        const out = await annotateScreenshot(base, many);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(1200);
    });
    it("escapes XML-unsafe characters in label text without throwing", async () => {
        // The label number itself is the only text drawn (not el.text), but the
        // SVG builder runs escapeXml on it. If we ever pipe text into the badge,
        // this needs to keep working. Smoke check that an extreme label survives.
        const base = await blankPng(200, 200);
        const out = await annotateScreenshot(base, [el(9999, 10, 10, 50, 50)]);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(200);
    });
});
//# sourceMappingURL=annotate.test.js.map