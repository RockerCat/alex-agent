// Shared CTA label/destination contract (real production incident,
// 2026-09-17): ContentBrief.cta previously conflated a short visible
// label with an optional destination URL into one string (e.g.
// "Comenzar gratis — https://solardesk.co/register"). That combined
// string is exactly what the asset renderer measures for its
// single-line CTA pill (lib/agent/assetRenderer.ts) — an ordinary short
// label plus a URL routinely doesn't fit once the Visual Director picks
// a bolder emphasis.
//
// `cta`/`cta_text` are now a label only. `ctaUrl`/`content_drafts.cta_url`
// is the separate, optional destination (see contentBriefSchema in
// lib/agent/schemas.ts). This module is the single place that resolves
// {label, url} for both new-style rows (cta_url populated) and legacy
// rows (cta_url null, URL still embedded in the combined cta/cta_text
// string) — reused by the asset renderer (label only) and Facebook
// publishing (url only), so neither has its own ad hoc parsing, and no
// existing row is ever mutated to benefit from this.

export interface CtaLabelAndUrl {
  label: string;
  url: string | null;
}

/** Standard-library URL parsing only (no custom regex URL grammar). http(s) only. */
export function isValidCtaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Deliberately narrow: only flags a string that contains real URL
// syntax (scheme + non-whitespace) — never a heuristic guess over
// arbitrary text.
const EMBEDDED_URL_PATTERN = /https?:\/\/\S+/i;

/** True when `text` itself contains an embedded http(s) URL — a CTA *label* should never carry one; it's rendered directly into the image. */
export function containsEmbeddedUrl(text: string): boolean {
  return EMBEDDED_URL_PATTERN.test(text);
}

// Matches a trailing "<label> <separator>? <url>" shape, where
// <separator> is an optional dash/em-dash. Deterministic and narrow: it
// only ever extracts a substring that is subsequently validated with
// the standard URL parser (isValidCtaUrl) below — it never guesses at
// arbitrary trailing text as a destination.
const TRAILING_URL_PATTERN = /\s*[-—–]?\s*(https?:\/\/\S+)\s*$/i;

/**
 * Legacy compatibility only: derives {label, url} from a pre-existing
 * combined cta/cta_text string (rows persisted before cta_url existed).
 * Purely a read-time interpretation — never mutates or repairs stored
 * data. If no valid trailing URL is found, the whole string is treated
 * as the label with no destination, unchanged from today's behavior.
 */
export function deriveLegacyCtaLabelAndUrl(combined: string): CtaLabelAndUrl {
  const match = combined.match(TRAILING_URL_PATTERN);
  if (!match) return { label: combined.trim(), url: null };

  const candidateUrl = match[1];
  if (!isValidCtaUrl(candidateUrl)) return { label: combined.trim(), url: null };

  const label = combined.slice(0, match.index).trim();
  return { label: label.length > 0 ? label : combined.trim(), url: candidateUrl };
}

/**
 * Canonical resolver: the ONLY place the renderer/publishing should
 * read a draft's CTA label and destination from. New-style rows
 * (cta_url populated) use it directly; legacy rows (cta_url null) fall
 * back to deriveLegacyCtaLabelAndUrl on the existing combined cta_text.
 */
export function resolveCtaLabelAndUrl(draft: { cta_text: string | null; cta_url: string | null }): CtaLabelAndUrl {
  const label = draft.cta_text ?? "";
  if (draft.cta_url) {
    return { label, url: isValidCtaUrl(draft.cta_url) ? draft.cta_url : null };
  }
  return deriveLegacyCtaLabelAndUrl(label);
}
