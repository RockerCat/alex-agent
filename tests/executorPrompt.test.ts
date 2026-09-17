import { describe, it, expect } from "vitest";
import { buildExecutorPrompt } from "@/lib/agent/executor";
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
});
