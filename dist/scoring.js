/**
 * Element types and query words that should all match an "input-like" intent.
 * GitHub's search field is type=combobox; "Enter your email" is type=input;
 * both should rank for a query like "search input". Without this synonym set
 * the type-bonus only fires on exact name match — so a query for "input"
 * misses every combobox/textbox/textarea in the page.
 *
 * Used symmetrically: if the query word AND the element type are both in
 * this set, give the type-bonus.
 */
const INPUT_LIKE = new Set([
    "input",
    "textarea",
    "textbox",
    "combobox",
    "searchbox",
    "field",
    "textfield",
]);
/**
 * Ranks elements against a natural-language description. Pure text/role
 * matching — no embeddings, no vision. The model has already seen the page;
 * find_label just lets it pick by description instead of re-checking label
 * numbers.
 */
export function scoreElements(elements, description) {
    const desc = description.toLowerCase().trim();
    if (!desc)
        return [];
    const descTokens = tokenize(desc);
    const scored = elements.map((el) => {
        // Only the element's text goes in the haystack — NOT its type. The old
        // version concatenated `${el.text} ${el.type}` and tokenized, which made
        // the type-name appear as a text-token-match (+3) AND as the explicit
        // type-bonus (+2). Result: input elements double-scored against the
        // query word "input", outranking elements whose actual text matched.
        // Concretely on github.com's open search modal, the email field beat
        // the focused search combobox for the query "search input".
        const text = (el.text ?? "").toLowerCase();
        const textTokens = tokenize(text);
        const elType = el.type.toLowerCase();
        let score = 0;
        // Whole-phrase substring match — strongest signal.
        if (text.includes(desc))
            score += 10;
        // Token overlap on TEXT only. Substring fuzziness requires both tokens to
        // be ≥ 3 chars — otherwise a single letter like "e" (from splitting
        // "e-mail") matches anything containing that letter and dominates with
        // noise.
        for (const t of descTokens) {
            if (textTokens.includes(t)) {
                score += 3;
            }
            else if (t.length >= 3 &&
                textTokens.some((h) => h.length >= 3 && (h.includes(t) || t.includes(h)))) {
                score += 1;
            }
        }
        // Type-name bonus. Plain exact match ("the submit button" + type=button)
        // PLUS synonym expansion for input-like types (so "input" / "field" /
        // "textbox" all match input / textarea / combobox / searchbox / etc.).
        for (const t of descTokens) {
            if (t === elType) {
                score += 2;
            }
            else if (INPUT_LIKE.has(t) && INPUT_LIKE.has(elType)) {
                score += 2;
            }
        }
        return {
            label: el.label,
            score,
            text: el.text.slice(0, 120),
            type: el.type,
        };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}
function tokenize(s) {
    return s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0);
}
//# sourceMappingURL=scoring.js.map