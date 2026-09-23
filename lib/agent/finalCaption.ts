import type { ContentDraftRow, PublicationChannel } from "@/lib/types/database";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";
import { EXECUTOR_TEXT_LIMITS } from "@/lib/agent/schemas";

// The ONE canonical composer for the exact social caption a draft is
// published with. Both publishers (lib/agent/publish.ts — Facebook and
// Instagram) and the finished-publication review email
// (lib/agent/emailTemplates.ts) call this, so the text Alex reviews is
// byte-for-byte the text sent to Meta.
//
// Deterministic, pure, no LLM — it never invents copy or hashtags:
//   1. base: the draft caption, falling back to the hook (the existing
//      publisher fallback), trimmed;
//   2. CTA destination: appended once (blank line before) when the draft
//      has a resolvable CTA URL the caption doesn't already contain —
//      the pre-existing composeCaptionWithCtaDestination behavior;
//   3. hashtags: draft.hashtags appended on their own final line (blank
//      line before), each normalized to a single "#tag" token, skipping
//      any already present in the text (case-insensitive) and duplicates
//      within the list.

type CaptionSource = Pick<ContentDraftRow, "caption" | "hook" | "cta_text" | "cta_url" | "hashtags">;

/** The base text the publishers require; empty means the draft has nothing publishable. */
export function baseSocialCaption(draft: Pick<ContentDraftRow, "caption" | "hook">): string {
  return (draft.caption ?? draft.hook ?? "").trim();
}

function normalizeHashtag(raw: string): string | null {
  const token = raw.trim().replace(/^#+/, "");
  if (!token || /\s/.test(token)) return null;
  return `#${token}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsHashtag(text: string, hashtag: string): boolean {
  // "#solar" must not match inside "#solarenergy" — the tag has to end at
  // a non-word character (or the end of the text).
  return new RegExp(`(^|[^\\p{L}\\p{N}_#])${escapeRegExp(hashtag)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

export function composeFinalSocialCaption(draft: CaptionSource): string {
  let caption = baseSocialCaption(draft);
  if (!caption) return "";

  const { url: ctaDestination } = resolveCtaLabelAndUrl(draft);
  if (ctaDestination && !caption.includes(ctaDestination)) {
    caption = `${caption}\n\n${ctaDestination}`;
  }

  const toAppend: string[] = [];
  for (const raw of draft.hashtags ?? []) {
    const tag = normalizeHashtag(raw);
    if (!tag) continue;
    if (textContainsHashtag(caption, tag)) continue;
    if (toAppend.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    toAppend.push(tag);
  }
  return toAppend.length > 0 ? `${caption}\n\n${toAppend.join(" ")}` : caption;
}

/**
 * Instagram's caption ceiling as this project already represents it: the
 * existing 2,200-character `caption` limit (EXECUTOR_TEXT_LIMITS in
 * lib/agent/schemas.ts). That limit only ever constrained draft.caption;
 * the composed final caption adds the CTA destination and hashtags, so it
 * can exceed it — which is exactly what checkFinalSocialCaption() guards.
 */
export const INSTAGRAM_CAPTION_MAX_LENGTH = EXECUTOR_TEXT_LIMITS.caption;

export type FinalCaptionCheck = { ok: true; caption: string } | { ok: false; reason: string };

/**
 * Validates the EXACT composed final caption (not draft.caption) for the
 * destination channel. Never truncates and never drops the CTA or
 * hashtags — an over-limit caption fails closed with a sanitized reason
 * (lengths only, never caption text). Length is counted in UTF-16 code
 * units (JavaScript string length) — the same semantics as the existing
 * schema limit, and never fewer than the number of characters, so it can
 * only err on the side of refusing. Facebook has no caption constraint in
 * this codebase, so only emptiness is checked there (unchanged behavior).
 */
export function checkFinalSocialCaption(draft: CaptionSource, channel: PublicationChannel): FinalCaptionCheck {
  const caption = composeFinalSocialCaption(draft);
  if (!caption) return { ok: false, reason: "The draft has no approved caption or hook to publish." };
  if (channel === "instagram" && caption.length > INSTAGRAM_CAPTION_MAX_LENGTH) {
    return {
      ok: false,
      reason: `The final Instagram caption (caption + CTA link + hashtags) is ${caption.length} characters; Instagram allows at most ${INSTAGRAM_CAPTION_MAX_LENGTH}. It was not truncated.`,
    };
  }
  return { ok: true, caption };
}
