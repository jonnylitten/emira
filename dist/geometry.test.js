import { describe, expect, it } from "vitest";
import { bboxIntersects, containmentRatio, suppressNested, } from "./geometry.js";
const box = (x, y, w, h) => ({
    x,
    y,
    w,
    h,
});
describe("bboxIntersects", () => {
    it("returns true for fully overlapping boxes", () => {
        expect(bboxIntersects(box(0, 0, 100, 100), box(10, 10, 50, 50))).toBe(true);
    });
    it("returns true for partially overlapping boxes", () => {
        expect(bboxIntersects(box(0, 0, 50, 50), box(40, 40, 50, 50))).toBe(true);
    });
    it("returns false for disjoint boxes", () => {
        expect(bboxIntersects(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(false);
    });
    it("returns true for edge-touching boxes", () => {
        // Edge contact: not the most useful behavior either way, but documenting:
        // (0..10) touches (10..20) at x=10. Intersection is one-pixel sliver.
        expect(bboxIntersects(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(true);
    });
});
describe("containmentRatio", () => {
    it("returns 1 when inner is fully contained", () => {
        expect(containmentRatio(box(0, 0, 100, 100), box(10, 10, 20, 20))).toBe(1);
    });
    it("returns 0 when disjoint", () => {
        expect(containmentRatio(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
    });
    it("returns partial overlap ratio", () => {
        // Inner is 20x20=400. Half (200) overlaps outer.
        const ratio = containmentRatio(box(0, 0, 50, 50), box(40, 40, 20, 20));
        expect(ratio).toBeCloseTo(100 / 400, 5); // 10x10 intersection / 20x20 inner
    });
    it("handles zero-area inner without dividing by zero", () => {
        expect(containmentRatio(box(0, 0, 100, 100), box(50, 50, 0, 0))).toBe(0);
    });
});
describe("suppressNested", () => {
    it("drops wrapper when inner sits fully inside", () => {
        const items = [
            { bbox: box(0, 0, 100, 100), tag: "wrapper" },
            { bbox: box(10, 10, 20, 20), tag: "inner" },
        ];
        const out = suppressNested(items);
        expect(out).toHaveLength(1);
        expect(out[0].tag).toBe("inner");
    });
    it("keeps both when inner is not mostly inside outer", () => {
        const items = [
            { bbox: box(0, 0, 100, 100), tag: "left" },
            { bbox: box(95, 0, 100, 100), tag: "right-partial" }, // 5% overlap
        ];
        const out = suppressNested(items);
        expect(out).toHaveLength(2);
    });
    it("respects the threshold parameter", () => {
        // Outer 100x100 (area 10000). Inner 40x40 at (80,80)-(120,120), area 1600.
        // Overlap with outer = 20x20 = 400. containmentRatio(outer, inner) = 0.25.
        const items = [
            { bbox: box(0, 0, 100, 100), tag: "outer" },
            { bbox: box(80, 80, 40, 40), tag: "inner" },
        ];
        expect(suppressNested(items, 0.8)).toHaveLength(2); // 0.25 < 0.8 → keep both
        expect(suppressNested(items, 0.2)).toHaveLength(1); // 0.25 ≥ 0.2 → drop outer
    });
    it("does not drop equal-area items", () => {
        const items = [
            { bbox: box(0, 0, 100, 100), tag: "a" },
            { bbox: box(0, 0, 100, 100), tag: "b" },
        ];
        expect(suppressNested(items)).toHaveLength(2);
    });
    it("handles chained nesting (grandparent / parent / child)", () => {
        const items = [
            { bbox: box(0, 0, 100, 100), tag: "grand" },
            { bbox: box(5, 5, 50, 50), tag: "parent" },
            { bbox: box(10, 10, 20, 20), tag: "child" },
        ];
        const out = suppressNested(items);
        // Only the innermost child survives — both wrappers contain it.
        expect(out.map((it) => it.tag)).toEqual(["child"]);
    });
    it("preserves order of survivors", () => {
        const items = [
            { bbox: box(0, 0, 10, 10), tag: "a" },
            { bbox: box(20, 0, 10, 10), tag: "b" },
            { bbox: box(40, 0, 10, 10), tag: "c" },
        ];
        expect(suppressNested(items).map((it) => it.tag)).toEqual(["a", "b", "c"]);
    });
    it("protects directly-interactive elements from being dropped as containers", () => {
        // Regression for the GitHub search combobox bug: a wide <input> 1060px
        // wide geometrically contains smaller buttons at its edges. Without
        // protection, suppressNested drops the input as a "container."
        const items = [
            { bbox: box(0, 0, 1060, 32), type: "input" }, // the wide search combobox
            { bbox: box(900, 4, 80, 24), type: "button" }, // a small button at the edge
            { bbox: box(990, 4, 60, 24), type: "a" }, // a small link at the other edge
        ];
        const noProtect = suppressNested(items);
        expect(noProtect.map((it) => it.type)).toEqual(["button", "a"]); // input wrongly dropped
        const withProtect = suppressNested(items, 0.8, (it) => ["a", "button", "input"].includes(it.type));
        expect(withProtect.map((it) => it.type)).toEqual(["input", "button", "a"]);
    });
    it("still drops genuine non-interactive wrappers when the protected set excludes them", () => {
        // <div onclick> wrapping a real <button>. The div made it into the
        // candidate set via [onclick] but is not in the protected set.
        const items = [
            { bbox: box(0, 0, 200, 100), type: "div" }, // wrapper, not in protected set
            { bbox: box(50, 30, 100, 40), type: "button" }, // real button inside
        ];
        const out = suppressNested(items, 0.8, (it) => ["a", "button", "input"].includes(it.type));
        expect(out.map((it) => it.type)).toEqual(["button"]); // div suppressed
    });
});
//# sourceMappingURL=geometry.test.js.map