import { describe, expect, it } from "vitest";
import { scoreElements } from "./scoring.js";
function el(label, type, text) {
    return {
        label,
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        type,
        text,
        interactive: true,
    };
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
    it("treats combobox/textbox/etc. as input-equivalent for the type bonus", () => {
        // Regression for the GitHub-search-modal case: query "search input"
        // should rank the combobox whose text is "Search" higher than the
        // input whose text is "Enter your email". Before the fix, the email
        // input won because "input" appeared in its haystack twice (text
        // tokens + type bonus), while the combobox didn't get the input-type
        // bonus at all.
        const els = [
            el(1, "input", "Enter your email"),
            el(2, "combobox", "Search"),
            el(3, "button", "Search or jump to…"),
        ];
        const out = scoreElements(els, "search input");
        expect(out[0]?.text).toBe("Search");
        expect(out[0]?.type).toBe("combobox");
    });
    it("does not regress 'email input' — actual email input still wins", () => {
        // Counter-check: when both the text AND type intent match the input
        // element, it should still win over a combobox with unrelated text.
        const els = [
            el(1, "input", "Enter your email"),
            el(2, "combobox", "Search"),
        ];
        const out = scoreElements(els, "email input");
        expect(out[0]?.text).toBe("Enter your email");
    });
    it("button type-name match still works (no input-synonym regression)", () => {
        // The button-side type bonus uses plain exact match. Make sure adding
        // input-synonyms didn't break the existing button-matching path.
        const els = [
            el(1, "button", "Cancel"),
            el(2, "button", "Submit order"),
        ];
        const out = scoreElements(els, "submit button");
        expect(out[0]?.text).toBe("Submit order");
    });
});
//# sourceMappingURL=scoring.test.js.map