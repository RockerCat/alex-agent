// Shared deterministic defense against mechanical truncation (root
// cause first documented in lib/agent/draftValidator.ts, live incident
// 2026-09-09): OpenAI Structured Outputs' constrained decoding can
// force-close a string exactly at its JSON Schema `maxLength`, producing
// syntactically valid, schema-compliant output whose prose is
// nonetheless cut off mid-thought. Both the Executor's output
// (lib/agent/draftValidator.ts) and the Planner's ContentBrief fields
// (lib/agent/planValidator.ts) are generated through the same
// Structured Outputs mechanism and can exhibit the identical failure
// shape, so the detection heuristic is shared rather than duplicated.

// A string ending in one of these is presumed a deliberately finished
// thought (a sentence, a quote, a trailing colon before a list rendered
// elsewhere, a closing parenthesis). Intentionally short and permissive:
// this is not a grammar checker, and legitimate copy ending in an emoji
// or other character outside this set is never flagged by this alone —
// only the exact-length match in isMechanicallyTruncated does that work.
export const TERMINAL_CHARACTERS = new Set([".", "!", "?", "…", '"', "”", "'", "’", ")", ":"]);

export function endsWithTerminalCharacter(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.length > 0 && TERMINAL_CHARACTERS.has(trimmed[trimmed.length - 1]);
}

/**
 * True only when `text` lands at EXACTLY `limit` characters AND does not
 * end in ordinary closing punctuation — the one shape a natural,
 * deliberately-written string is astronomically unlikely to produce by
 * coincidence. Deliberately narrow: a structural/mechanical signal, not
 * prose-quality analysis. Never flags legitimate copy for being short,
 * blunt, or ending in an emoji, and never flags a string short of the
 * exact ceiling (a truncation that lands short of the boundary is
 * indistinguishable from a deliberately concise string — a documented,
 * accepted limitation, not something this heuristic claims to catch).
 */
export function isMechanicallyTruncated(text: string, limit: number): boolean {
  return text.length === limit && !endsWithTerminalCharacter(text);
}
