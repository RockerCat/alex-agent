import { describe, it, expect } from "vitest";
import { buildExecutorPrompt, type RevisionInstruction } from "@/lib/agent/executor";
import type { AgentContext } from "@/lib/agent/contextLoader";
import type { ContentBrief } from "@/lib/agent/schemas";

// Focused, string-level check that the Executor's Channel Content
// Rules v1 guidance and the visual_direction ownership boundary
// (lib/agent/executor.ts) actually reached the system prompt — not a
// full prompt-testing framework, just confirming the instructions exist.

const context: AgentContext = {
  brand: "solardesk",
  agentMd: "",
  brandMd: "BRAND.md content",
  activePlan: null,
  draftsForActivePlan: [],
  openQuestions: [],
  recentAnsweredQuestions: [],
  recentRuns: [],
};

const brief: ContentBrief = {
  purpose: "education",
  channel: "instagram",
  format: "carousel",
  topic: "Topic",
  audience: "aud",
  cta: "cta",
  ctaUrl: null,
  targetDate: "2026-09-12",
};

describe("Executor system prompt — Channel Content Rules v1", () => {
  const { system } = buildExecutorPrompt(context, brief);

  it("distinguishes Instagram and Facebook as different publishing contexts", () => {
    expect(system).toMatch(/Instagram and Facebook are different publishing contexts/i);
  });

  it("states editorial (non-quota) caption/hashtag/slide targets for both channels", () => {
    expect(system).toMatch(/300-600 characters/);
    expect(system).toMatch(/3-5 genuinely relevant hashtags/);
    expect(system).toMatch(/300-800 characters/);
    expect(system).toMatch(/0-3 genuinely relevant hashtags/);
    expect(system).toMatch(/never pad copy, slides, or hashtags merely to reach a preferred range\/count/i);
  });

  it("requires exactly one clear primary CTA without repetition", () => {
    expect(system).toMatch(/exactly one clear primary CTA/i);
  });

  it("states the carousel (3-6 slides) and image_post (exactly 1 slide) structural invariants", () => {
    expect(system).toMatch(/between 3 and 6 items/);
    expect(system).toMatch(/exactly 1 item/);
  });

  it("restricts visualDirection to communicative intent, excluding low-level render details", () => {
    expect(system).toMatch(/visualDirection must describe communicative visual intent only/i);
    expect(system).toMatch(/hex codes/i);
    expect(system).toMatch(/font families or sizes/i);
    expect(system).toMatch(/coordinates/i);
    expect(system).toMatch(/pixel measurements/i);
    expect(system).toMatch(/Visual Director/);
  });

  it("distinguishes the cta label from ctaUrl and forbids embedding a URL in the generated cta", () => {
    expect(system).toMatch(/`ctaUrl`.*is a separate, fixed destination/i);
    expect(system).toMatch(/must never append, restate, or otherwise embed `ctaUrl`/i);
  });
});

// Real production incident (2026-09-17): a narrow revision note asking
// only to fix a corrupted `purpose` string could never succeed (purpose
// is brief-level, not revision-editable output) and a separate narrow
// hook-only feedback request also caused unrelated fields to be
// regenerated. These checks confirm the minimal prompt/context fix in
// lib/agent/executor.ts actually reached the revision-call prompt.

const revisionInstruction: RevisionInstruction = {
  category: "weak_hook",
  note: "The hook doesn't grab attention",
  previousContent: {
    title: "Título original",
    hook: "Hook original débil",
    slides: [{ slide: 1, text: "Slide original" }],
    caption: "Caption original",
    cta: "CTA original",
    visualDirection: "Visual direction original",
    hashtags: ["#solar"],
  },
};

describe("Executor revision prompt — narrow-feedback preservation and brief boundary", () => {
  const { user } = buildExecutorPrompt(context, brief, revisionInstruction);

  it("instructs the model to preserve unrelated, still-valid previous fields on narrow feedback", () => {
    expect(user).toMatch(/keep the previous version's fields that are unrelated to the requested change unchanged/i);
    expect(user).toMatch(/never rewrite an unaffected field merely for stylistic variety/i);
  });

  it("tells the model the actual change must be reflected, not a restated previous version", () => {
    expect(user).toMatch(/the new version must actually reflect the requested change, not merely restate the previous version/i);
  });

  it("identifies the ContentBrief (including ctaUrl) as fixed context, not revision-editable output", () => {
    expect(user).toMatch(/fixed context, not revision-editable output/i);
    expect(user).toMatch(/your output schema has no field for it/i);
    expect(user).toMatch(/purpose, channel, format, topic, audience, cta, ctaUrl, targetDate/);
  });

  it("supplies all editable/versioned Executor-output fields as previous content, not just title/hook/caption/cta", () => {
    expect(user).toContain('"slides"');
    expect(user).toContain("Slide original");
    expect(user).toContain('"visualDirection"');
    expect(user).toContain("Visual direction original");
    expect(user).toContain('"hashtags"');
    expect(user).toContain("#solar");
  });
});
