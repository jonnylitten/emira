import { describe, expect, it } from "vitest";
import { scoreElements } from "./scoring.js";
function el(label, type, text) {
    return { label, bbox: { x: 0, y: 0, w: 10, h: 10 }, type, text };
}
describe("scoreElements", () => {
    const elements = [
        el(1, "input", "Customer name:"),
        el(2, "input", "Telephone:"),
        el(3, "input", "E-mail address:"),
        el(4, "input", "Medium"),
        el(5, "input", "Bacon"),
        el(6, "button", "Submit order"),
        el(7, "a", "Marie Curie"),
        el(8, "a", "Wikipedia"),
    ];
    it("returns empty for empty description", () => {
        expect(scoreElements(elements, "")).toEqual([]);
        expect(scoreElements(elements, "   ")).toEqual([]);
    });
    it("ranks exact phrase match highest", () => {
        const out = scoreElements(elements, "submit order");
        expect(out[0]?.label).toBe(6);
        expect(out[0]?.text).toBe("Submit order");
    });
    it("scores by token overlap when no exact phrase match", () => {
        const out = scoreElements(elements, "medium pizza size");
        expect(out[0]?.label).toBe(4);
    });
    it("returns empty when nothing matches", () => {
        const out = scoreElements(elements, "nonexistent gibberish xyz");
        expect(out).toEqual([]);
    });
    it("ranks single-word matches", () => {
        const out = scoreElements(elements, "bacon");
        expect(out[0]?.label).toBe(5);
        expect(out[0]?.text).toBe("Bacon");
    });
    it("respects type-keyword bonus (submit + button)", () => {
        // "button" alone shouldn't outrank a real text match
        const els = [
            el(1, "button", "Cancel"),
            el(2, "button", "Submit order"),
        ];
        const out = scoreElements(els, "submit button");
        expect(out[0]?.label).toBe(2);
    });
    it("is case insensitive", () => {
        const out = scoreElements(elements, "MARIE CURIE");
        expect(out[0]?.label).toBe(7);
    });
    it("truncates returned text to 120 chars", () => {
        const longText = "x".repeat(200);
        const els = [el(1, "p", longText)];
        const out = scoreElements(els, "x");
        expect(out[0]?.text.length).toBeLessThanOrEqual(120);
    });
    it("orders results by descending score", () => {
        const out = scoreElements(elements, "address");
        for (let i = 1; i < out.length; i++) {
            expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
        }
    });
});
//# sourceMappingURL=scoring.test.js.map