import { describe, it, expect } from "vitest";
import { validateDraft } from "@/lib/agent/draftValidator";
import { carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { ContentBrief } from "@/lib/agent/schemas";

// Channel Content Rules v1 — deterministic format invariants:
// carousel must have 3-6 slides, image_post must have exactly 1.
// These are hard structural rules (lib/agent/draftValidator.ts), not
// the Executor's editorial-guidance targets (caption/hashtag/per-slide
// length remain prompt guidance only and are not asserted here).

const carouselBrief: ContentBrief = {
  purpose: "education",
  channel: "instagram",
  format: "carousel",
  topic: "Topic",
  audience: "aud",
  cta: "cta",
  ctaUrl: null,
  targetDate: "2026-09-12",
};

const imagePostBrief: ContentBrief = { ...carouselBrief, channel: "facebook", format: "image_post" };

function slidesOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ slide: i + 1, text: `Slide ${i + 1} body text.` }));
}

describe("draftValidator — carousel slide-count range (3-6)", () => {
  it("3 slides is valid", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(3) }), carouselBrief);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("6 slides is valid", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(6) }), carouselBrief);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("7 slides is rejected deterministically", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(7) }), carouselBrief);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("carousel format requires between 3 and 6 slides"))).toBe(true);
  });

  it("fewer than 3 slides remains rejected", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(2) }), carouselBrief);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("carousel format requires between 3 and 6 slides"))).toBe(true);
  });
});

describe("draftValidator — image_post single-panel invariant", () => {
  it("exactly 1 slide is valid", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(1) }), imagePostBrief);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("multiple slides is rejected deterministically", () => {
    const result = validateDraft(carouselExecutorOutput({ slides: slidesOf(3) }), imagePostBrief);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("image_post format requires exactly 1 slide"))).toBe(true);
  });
});

describe("draftValidator — unaffected content types keep their existing (unconstrained) slide behavior", () => {
  it("story and caption_only briefs are not subject to the carousel/image_post slide-count checks", () => {
    const storyBrief: ContentBrief = { ...carouselBrief, format: "story" };
    const captionOnlyBrief: ContentBrief = { ...carouselBrief, format: "caption_only" };

    // Any slide count — including counts that would fail the carousel
    // or image_post rules — passes structurally for these formats,
    // exactly as before this change.
    expect(validateDraft(carouselExecutorOutput({ slides: slidesOf(1) }), storyBrief).valid).toBe(true);
    expect(validateDraft(carouselExecutorOutput({ slides: slidesOf(7) }), captionOnlyBrief).valid).toBe(true);
  });
});

// CTA label/destination contract (real production incident, 2026-09-17):
// the Executor's own `cta` output is rendered directly into the image
// as a single line of text, so it must never carry a URL either —
// mirroring the same structural check already applied to the Planner's
// brief-level `cta` (see tests/planValidator.test.ts).
describe("draftValidator — Executor cta must not contain a URL", () => {
  it("a short cta label is valid", () => {
    const result = validateDraft(carouselExecutorOutput({ cta: "Comenzar gratis" }), carouselBrief);
    expect(result.valid).toBe(true);
  });

  it("a cta with an embedded URL (the real incident shape) is rejected deterministically", () => {
    const result = validateDraft(
      carouselExecutorOutput({ cta: "Comenzar gratis — https://solardesk.co/register" }),
      carouselBrief
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cta must be a short label and must not contain a URL"))).toBe(true);
  });
});
