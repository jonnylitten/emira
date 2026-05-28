import type { DetectedElement } from "./types.js";

export interface ScoredMatch {
  label: number;
  score: number;
  text: string;
  type: string;
}

/**
 * Ranks elements against a natural-language description. Pure text/role
 * matching — no embeddings, no vision. The model has already seen the page;
 * find_label just lets it pick by description instead of re-checking label
 * numbers.
 */
export function scoreElements(
  elements: DetectedElement[],
  description: string,
): ScoredMatch[] {
  const desc = description.toLowerCase().trim();
  if (!desc) return [];
  const descTokens = tokenize(desc);

  const scored: ScoredMatch[] = elements.map((el) => {
    const haystack = `${el.text} ${el.type}`.toLowerCase();
    const haystackTokens = tokenize(haystack);

    let score = 0;

    // Whole-phrase substring match — strongest signal.
    if (el.text && el.text.toLowerCase().includes(desc)) score += 10;

    // Token overlap. Substring fuzziness requires both tokens to be ≥ 3 chars
    // — otherwise a single letter like "e" (from splitting "e-mail") matches
    // anything containing that letter and dominates with noise.
    for (const t of descTokens) {
      if (haystackTokens.includes(t)) {
        score += 3;
      } else if (
        t.length >= 3 &&
        haystackTokens.some(
          (h) => h.length >= 3 && (h.includes(t) || t.includes(h)),
        )
      ) {
        score += 1;
      }
    }

    // Type/role mention bonus ("the submit button" + type=button).
    if (descTokens.includes(el.type.toLowerCase())) score += 2;

    return {
      label: el.label,
      score,
      text: el.text.slice(0, 120),
      type: el.type,
    };
  });

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
