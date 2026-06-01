export function bboxIntersects(a, b) {
    return !(a.x + a.w < b.x ||
        b.x + b.w < a.x ||
        a.y + a.h < b.y ||
        b.y + b.h < a.y);
}
/**
 * Fraction of `inner`'s area that falls inside `outer`. 1.0 means fully
 * contained, 0 means no overlap.
 */
export function containmentRatio(outer, inner) {
    const ix = Math.max(outer.x, inner.x);
    const iy = Math.max(outer.y, inner.y);
    const ax = Math.min(outer.x + outer.w, inner.x + inner.w);
    const ay = Math.min(outer.y + outer.h, inner.y + inner.h);
    const iw = Math.max(0, ax - ix);
    const ih = Math.max(0, ay - iy);
    const innerArea = inner.w * inner.h;
    if (innerArea === 0)
        return 0;
    return (iw * ih) / innerArea;
}
/**
 * Suppresses elements whose bbox almost fully contains a smaller sibling —
 * keeps the inner (more specific) box, drops the outer wrapper. Operates in
 * place on bbox-only records so it can be unit tested without a DOM.
 *
 * `protect` is an optional predicate: items where it returns true are NEVER
 * dropped, even if smaller items sit inside their bbox. This is the escape
 * hatch for the "wide interactive element contains smaller ones" pattern
 * (e.g. GitHub's full-width search combobox geometrically containing buttons
 * at its edges). Without protection, suppressNested wrongly classifies that
 * combobox as a wrapper and the agent never sees it.
 */
export function suppressNested(items, threshold = 0.8, protect) {
    const areas = items.map((it) => it.bbox.w * it.bbox.h);
    const keep = items.map(() => true);
    for (let i = 0; i < items.length; i++) {
        if (!keep[i])
            continue;
        for (let j = 0; j < items.length; j++) {
            if (i === j || !keep[j])
                continue;
            if (areas[j] > areas[i] &&
                containmentRatio(items[j].bbox, items[i].bbox) >= threshold &&
                !(protect && protect(items[j]))) {
                keep[j] = false;
            }
        }
    }
    return items.filter((_, i) => keep[i]);
}
//# sourceMappingURL=geometry.js.map