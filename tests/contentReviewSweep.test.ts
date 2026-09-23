import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { runContentReviewEmailSweep, type ContentReviewEmailDeps } from "@/lib/agent/contentReviewSweep";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { ScriptedEmailClient, emailRejection } from "@/tests/support/fakeEmailClient";

// Automatic content-review emails from the normal wake: durable
// pending_approval drafts → exactly one review email per version, through
// the existing prepare/deliver + notification_outbox infrastructure.
// Scripted email client only — no real email, no model, no Meta.

const BASE_URL = "https://agent.alexsosa.me";
const ids = ["a", "b", "c", "d"].map((c) => `${c.repeat(8)}-1111-4111-8111-111111111111`);

function draft(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    plan_id: "plan-1",
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "p",
    topic: `Tema ${id.slice(0, 1)}`,
    audience: "a",
    cta: "Comenzar gratis",
    cta_url: "https://solardesk.co/register",
    target_date: "2026-09-26",
    status: "pending_approval",
    version: 1,
    title: `Título ${id.slice(0, 1)}`,
    hook: "Hook",
    body: { slides: [{ slide: 1, text: "Texto" }] },
    caption: "Caption",
    cta_text: "Comenzar gratis",
    visual_direction: "Visual",
    hashtags: ["#solar"],
    blocked_on_question_id: null,
    approved_at: null,
    rejected_at: null,
    created_at: `2026-09-25T13:0${ids.indexOf(id)}:00Z`,
    updated_at: "2026-09-25T13:00:00Z",
    ...overrides,
  };
}

function setup(drafts: Record<string, unknown>[], emailClient = new ScriptedEmailClient()) {
  const fake = createFakeDb();
  fake.seed("marketing_plans", [{ id: "plan-1", brand: "solardesk", primary_objective: "SIGNUPS", status: "active" }]);
  fake.seed("content_drafts", drafts);
  const deps: ContentReviewEmailDeps = {
    db: asSupabaseClient<SupabaseClient<Database>>(fake),
    emailClient,
    addressing: { from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" },
    baseUrl: BASE_URL,
  };
  return { fake, deps, emailClient };
}

const reviewRows = (fake: FakeDb) => fake.getAll("notification_outbox").filter((r) => r.notification_type === "draft_pending_approval");

describe("runContentReviewEmailSweep", () => {
  it("a new pending draft gets exactly one content-review email with Aprobar/Rechazar", async () => {
    const { fake, deps, emailClient } = setup([draft(ids[0])]);
    expect(await runContentReviewEmailSweep(deps)).toEqual({ outcomes: ["sent"] });

    expect(emailClient.sendCalls).toHaveLength(1);
    expect(emailClient.sendCalls[0].subject).toContain("Revisión de contenido v1");
    expect(emailClient.sendCalls[0].text).toContain(`Aprobar: ${BASE_URL}/email/action#t=`);
    expect(emailClient.sendCalls[0].text).toContain(`Rechazar: ${BASE_URL}/email/action#t=`);
    expect(reviewRows(fake)).toEqual([expect.objectContaining({ channel: "email", subject_id: ids[0], subject_version: 1, status: "sent" })]);
    expect(fake.getAll("email_action_tokens").map((t) => t.action).sort()).toEqual(["approve_draft", "reject_draft"]);
  });

  it("multiple pending drafts (e.g. a new plan) each get their own review", async () => {
    const { fake, deps, emailClient } = setup(ids.slice(0, 3).map((id) => draft(id)));
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["sent", "sent", "sent"]);
    expect(emailClient.sendCalls).toHaveLength(3);
    expect(reviewRows(fake).map((r) => r.subject_id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(fake.getAll("email_action_tokens")).toHaveLength(6);
  });

  it("a sent review is never resent on later wakes (no duplicate notifications or tokens)", async () => {
    const { fake, deps, emailClient } = setup([draft(ids[0])]);
    await runContentReviewEmailSweep(deps);
    expect(await runContentReviewEmailSweep(deps)).toEqual({ outcomes: [] });
    expect(emailClient.sendCalls).toHaveLength(1);
    expect(reviewRows(fake)).toHaveLength(1);
    expect(fake.getAll("email_action_tokens")).toHaveLength(2);
  });

  it("a failed review is retried on a later wake", async () => {
    const emailClient = new ScriptedEmailClient({ failSequence: [emailRejection("Resend rejected the email send request: boom"), null] });
    const { fake, deps } = setup([draft(ids[0])], emailClient);
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["delivery_failed"]);
    expect(reviewRows(fake)[0].status).toBe("failed");

    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["sent"]);
    expect(reviewRows(fake)).toEqual([expect.objectContaining({ status: "sent" })]); // same identity, reclaimed
  });

  it("a new draft version is a new review identity and gets a new email", async () => {
    const { fake, deps, emailClient } = setup([draft(ids[0])]);
    await runContentReviewEmailSweep(deps);
    await deps.db.from("content_drafts").update({ version: 2 }).eq("id", ids[0]);
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["sent"]);
    expect(emailClient.sendCalls[1].subject).toContain("Revisión de contenido v2");
    expect(reviewRows(fake).map((r) => r.subject_version).sort()).toEqual([1, 2]);
  });

  it("uses durable state only: emails pending drafts from any earlier wake, with no Planner output involved", async () => {
    // No agent_runs at all — the sweep takes no run/decision input.
    const { deps, emailClient } = setup([draft(ids[0], { created_at: "2026-09-20T13:00:00Z" })]);
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["sent"]);
    expect(emailClient.sendCalls).toHaveLength(1);
  });

  it("one failed email does not block the next draft", async () => {
    const emailClient = new ScriptedEmailClient({ failSequence: [emailRejection("Resend rejected the email send request: boom"), null] });
    const { fake, deps } = setup([draft(ids[0]), draft(ids[1])], emailClient);
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["delivery_failed", "sent"]);
    expect(reviewRows(fake).map((r) => r.status).sort()).toEqual(["failed", "sent"]);
  });

  it("is bounded per wake; the remainder continues on the next wake without skipping anyone", async () => {
    const { deps, emailClient } = setup(ids.map((id) => draft(id)));
    expect((await runContentReviewEmailSweep(deps, { limit: 2 })).outcomes).toEqual(["sent", "sent"]);
    expect((await runContentReviewEmailSweep(deps, { limit: 2 })).outcomes).toEqual(["sent", "sent"]);
    expect(emailClient.sendCalls).toHaveLength(4);
    expect(await runContentReviewEmailSweep(deps, { limit: 2 })).toEqual({ outcomes: [] });
  });

  it("carousel and image_post both get CONTENT review — and the sweep never generates an asset", async () => {
    const { fake, deps, emailClient } = setup([draft(ids[0], { content_type: "carousel", body: { slides: [1, 2, 3].map((n) => ({ slide: n, text: `S${n}` })) } }), draft(ids[1])]);
    expect((await runContentReviewEmailSweep(deps)).outcomes).toEqual(["sent", "sent"]);
    expect(emailClient.sendCalls.map((c) => c.subject.includes("Revisión de contenido"))).toEqual([true, true]);
    expect(fake.getAll("content_assets")).toHaveLength(0);
    expect(fake.getAll("agent_runs")).toHaveLength(0);
  });

  it("an image_post is only generated after a human email approval — never by the sweep itself", async () => {
    const { fake, deps, emailClient } = setup([draft(ids[0])]);
    await runContentReviewEmailSweep(deps);
    expect(fake.getAll("content_assets")).toHaveLength(0);
    // The review's own Aprobar link still decides exactly this version.
    const token = emailClient.sendCalls[0].text.match(/Aprobar: [^#]+#t=([A-Za-z0-9_-]{43})/)![1];
    expect((await confirmEmailAction(deps.db, token)).result).toBe("applied");
    expect(fake.getAll("content_drafts")[0].status).toBe("approved");
    expect(fake.getAll("content_assets")).toHaveLength(0); // generation is the confirm route's post-response continuation, not this sweep
  });

  it("skips drafts that aren't reviewable: not pending, blocked on a question, or an unsupported brand", async () => {
    const { deps, emailClient } = setup([
      draft(ids[0], { status: "approved" }),
      draft(ids[1], { status: "draft", version: 0 }),
      draft(ids[2], { blocked_on_question_id: "q-1" }),
      draft(ids[3], { brand: "mipadel" }),
    ]);
    expect(await runContentReviewEmailSweep(deps)).toEqual({ outcomes: [] });
    expect(emailClient.sendCalls).toHaveLength(0);
  });

  it("never calls a model, the Planner, asset generation, or a publisher (structural)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("lib/agent/contentReviewSweep.ts", "utf-8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/aiClient|planner|executor|runtime|assetGenerator|postApprovalContinuation|imageGeneration|publish|whatsapp|agent\/notifications"/i);
    }
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/generateAsset\(|runMarketingCycle\(|callPlanner\(|callExecutor\(/);
  });
});
