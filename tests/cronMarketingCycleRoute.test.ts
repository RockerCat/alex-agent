import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Autonomy v1 Phase 1B — tests the authenticated headless Route Handler
// (app/api/cron/marketing-cycle/route.ts) in isolation: no real Supabase
// or OpenAI client is ever constructed here. runMarketingCycle() itself
// is already covered by its own test suites (marketingCycleExpiry.test.ts,
// the acceptance suite, etc.) — this file only proves the Route
// Handler's own job: authenticate against Vercel Cron's native
// GET + `Authorization: Bearer <CRON_SECRET>` contract, then forward to
// that exact function with the exact expected arguments, and translate
// its result into a safe response.

const { runMarketingCycleMock, notifyAttentionIfNeededMock, createContinuationDepsMock, runSweepMock, createContentReviewDepsMock, runContentReviewSweepMock, createPublicationDepsMock, runPublicationSweepMock } = vi.hoisted(() => ({
  runMarketingCycleMock: vi.fn(),
  notifyAttentionIfNeededMock: vi.fn(),
  createContinuationDepsMock: vi.fn(),
  runSweepMock: vi.fn(),
  createContentReviewDepsMock: vi.fn(),
  runContentReviewSweepMock: vi.fn(),
  createPublicationDepsMock: vi.fn(),
  runPublicationSweepMock: vi.fn(),
}));

vi.mock("@/lib/agent/postApprovalPublication", () => ({
  createProductionPublicationDeps: createPublicationDepsMock,
  runPublicationRecoverySweep: runPublicationSweepMock,
}));

vi.mock("@/lib/agent/contentReviewSweep", () => ({
  createProductionContentReviewDeps: createContentReviewDepsMock,
  runContentReviewEmailSweep: runContentReviewSweepMock,
}));

vi.mock("@/lib/agent/postApprovalContinuation", () => ({
  createProductionContinuationDeps: createContinuationDepsMock,
  runPostApprovalContinuationSweep: runSweepMock,
}));

vi.mock("@/lib/agent/runtime", () => ({
  runMarketingCycle: runMarketingCycleMock,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(() => ({ __fake: "db" })),
}));

vi.mock("@/lib/agent/aiClient", () => ({
  OpenAiClient: vi.fn().mockImplementation(function FakeOpenAiClient() {
    return { __fake: "aiClient" };
  }),
}));

vi.mock("@/lib/agent/notifications", () => ({
  notifyAttentionIfNeeded: notifyAttentionIfNeededMock,
}));

vi.mock("@/lib/agent/whatsappClient", () => ({
  MetaGraphWhatsAppClient: vi.fn().mockImplementation(function FakeWhatsAppClient() {
    return { __fake: "whatsappClient" };
  }),
}));

import * as route from "@/app/api/cron/marketing-cycle/route";
const { GET } = route;

const SECRET = "test-cron-secret-do-not-use-in-prod";

function getRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request("http://localhost/api/cron/marketing-cycle", {
    method: "GET",
    headers,
  });
}

describe("GET /api/cron/marketing-cycle", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    runMarketingCycleMock.mockReset();
    notifyAttentionIfNeededMock.mockReset();
    notifyAttentionIfNeededMock.mockResolvedValue({ attempted: 0, sent: 0, alreadySent: 0, failed: 0, skippedNotConfigured: true });
    createContinuationDepsMock.mockReset();
    createContinuationDepsMock.mockReturnValue(null);
    runSweepMock.mockReset();
    runSweepMock.mockResolvedValue({ considered: 0, outcomes: [] });
    createContentReviewDepsMock.mockReset();
    createContentReviewDepsMock.mockReturnValue(null);
    runContentReviewSweepMock.mockReset();
    runContentReviewSweepMock.mockResolvedValue({ outcomes: [] });
    createPublicationDepsMock.mockReset();
    createPublicationDepsMock.mockReturnValue(null);
    runPublicationSweepMock.mockReset();
    runPublicationSweepMock.mockResolvedValue({ outcomes: [] });
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. GET is the implemented execution method", () => {
    expect(typeof route.GET).toBe("function");
  });

  it("2. POST is no longer exported as an execution handler on this route", () => {
    expect((route as Record<string, unknown>).POST).toBeUndefined();
  });

  it("3. missing server-side CRON_SECRET fails closed and never invokes the runtime", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(getRequest(`Bearer ${SECRET}`));

    expect(response.status).toBe(503);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("4. a missing Authorization header is rejected and never invokes the runtime", async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("5. an invalid auth scheme is rejected", async () => {
    const response = await GET(getRequest(`Basic ${SECRET}`));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("6. an empty Bearer token is rejected", async () => {
    const response = await GET(getRequest("Bearer "));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("7. a wrong Bearer token is rejected", async () => {
    const response = await GET(getRequest("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("8. a Bearer token of a different length than the real secret is rejected safely", async () => {
    const response = await GET(getRequest("Bearer short"));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("9. a valid Authorization: Bearer <CRON_SECRET> invokes the existing runtime with brand: solardesk, trigger: scheduled", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(runMarketingCycleMock).toHaveBeenCalledTimes(1);
    const call = runMarketingCycleMock.mock.calls[0][0];
    expect(call.brand).toBe("solardesk");
    expect(call.trigger).toBe("scheduled");
    expect(call.db).toBeDefined();
    expect(call.aiClient).toBeDefined();
  });

  it("10. a successful wake returns a safe, minimal JSON response", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      runId: "run-1",
      status: "completed",
      decision: "NO_ACTION",
      concurrent: false,
    });
  });

  it("11. a concurrent/skipped result is represented safely", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-2", status: "skipped", decision: null },
      concurrent: true,
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.concurrent).toBe(true);
    expect(body.status).toBe("skipped");
  });

  it("12. a runtime failure returns a safe server error without leaking internal details", async () => {
    runMarketingCycleMock.mockRejectedValue(new Error("service_role key rejected by postgres at 10.0.0.4:5432"));

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();
    const bodyText = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(bodyText).not.toContain("10.0.0.4");
    expect(bodyText).not.toContain("postgres");
  });

  it("13. the response never echoes the configured secret", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const bodyText = JSON.stringify(await response.json());

    expect(bodyText).not.toContain(SECRET);
  });

  it("14. invokes the WhatsApp attention notification service after a successful wake, with the run's id/decision/brand", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "WAIT_FOR_APPROVAL" },
    });

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(notifyAttentionIfNeededMock).toHaveBeenCalledTimes(1);
    const call = notifyAttentionIfNeededMock.mock.calls[0][0];
    expect(call.brand).toBe("solardesk");
    expect(call.runId).toBe("run-1");
    expect(call.runDecision).toBe("WAIT_FOR_APPROVAL");
    expect(call.whatsappClient).toBeDefined();
    expect(call.db).toBeDefined();
  });

  it("15. a WhatsApp notification failure does not fail the successful cron marketing-cycle response", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "WAIT_FOR_APPROVAL" },
    });
    notifyAttentionIfNeededMock.mockRejectedValue(new Error("Meta WhatsApp send failed with a raw provider stack trace"));

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      runId: "run-1",
      status: "completed",
      decision: "WAIT_FOR_APPROVAL",
      concurrent: false,
    });
  });

  it("16. an authentication failure never invokes the WhatsApp notification service", async () => {
    await GET(getRequest("Bearer wrong-secret"));

    expect(notifyAttentionIfNeededMock).not.toHaveBeenCalled();
  });

  it("17. runs the email post-approval catch-up sweep only after the marketing cycle has returned", async () => {
    const order: string[] = [];
    runMarketingCycleMock.mockImplementation(async () => {
      order.push("cycle");
      return { run: { id: "run-1", status: "completed", decision: "NO_ACTION" } };
    });
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });
    runSweepMock.mockImplementation(async () => {
      order.push("sweep");
      return { considered: 1, outcomes: ["review_sent"] };
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(runSweepMock).toHaveBeenCalledWith({ __fake: "deps" });
    expect(order).toEqual(["cycle", "sweep"]);
  });

  it("18. skips the sweep entirely when email/app origin isn't configured", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "completed", decision: "NO_ACTION" } });
    createContinuationDepsMock.mockReturnValue(null);

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(runSweepMock).not.toHaveBeenCalled();
  });

  it("19. a sweep failure never changes the successful cron response", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "completed", decision: "NO_ACTION" } });
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });
    runSweepMock.mockRejectedValue(new Error("image provider exploded with internal details"));

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, runId: "run-1", status: "completed", decision: "NO_ACTION", concurrent: false });
  });

  it("21. sends content-review emails from durable state after the cycle, before WhatsApp and the continuation sweep", async () => {
    const order: string[] = [];
    runMarketingCycleMock.mockImplementation(async () => {
      order.push("cycle");
      return { run: { id: "run-1", status: "completed", decision: "CREATE_PLAN" } };
    });
    createContentReviewDepsMock.mockReturnValue({ __fake: "reviewDeps" });
    runContentReviewSweepMock.mockImplementation(async () => {
      order.push("contentReview");
      return { outcomes: ["sent", "sent"] };
    });
    notifyAttentionIfNeededMock.mockImplementation(async () => {
      order.push("whatsapp");
      return { attempted: 0, sent: 0, alreadySent: 0, failed: 0, skippedNotConfigured: false };
    });
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });
    runSweepMock.mockImplementation(async () => {
      order.push("continuation");
      return { considered: 0, outcomes: [] };
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    // The sweep receives only its deps — never the Planner's decision/output.
    expect(runContentReviewSweepMock).toHaveBeenCalledWith({ __fake: "reviewDeps" });
    expect(order).toEqual(["cycle", "contentReview", "whatsapp", "continuation"]);
    expect(runMarketingCycleMock).toHaveBeenCalledTimes(1); // no additional Planner call
  });

  it("22. email review active: no duplicate WhatsApp notification for a pending-approval (WAIT_FOR_APPROVAL) wake", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "skipped", decision: "WAIT_FOR_APPROVAL" } });
    createContentReviewDepsMock.mockReturnValue({ __fake: "reviewDeps" });

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(runContentReviewSweepMock).toHaveBeenCalledTimes(1);
    expect(notifyAttentionIfNeededMock).not.toHaveBeenCalled();
  });

  it("23. email review active: blocking questions (NEEDS_HUMAN_INPUT) still use the existing WhatsApp path unchanged", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "completed", decision: "NEEDS_HUMAN_INPUT" } });
    createContentReviewDepsMock.mockReturnValue({ __fake: "reviewDeps" });

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(notifyAttentionIfNeededMock).toHaveBeenCalledTimes(1);
    expect(notifyAttentionIfNeededMock.mock.calls[0][0].runDecision).toBe("NEEDS_HUMAN_INPUT");
  });

  it("24. email review NOT configured: WAIT_FOR_APPROVAL falls back to the existing WhatsApp behavior", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "skipped", decision: "WAIT_FOR_APPROVAL" } });
    createContentReviewDepsMock.mockReturnValue(null);

    await GET(getRequest(`Bearer ${SECRET}`));

    expect(runContentReviewSweepMock).not.toHaveBeenCalled();
    expect(notifyAttentionIfNeededMock).toHaveBeenCalledTimes(1);
  });

  it("25. a content-review email failure never changes the cron response and never stops the later steps", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "completed", decision: "CREATE_PLAN" } });
    createContentReviewDepsMock.mockReturnValue({ __fake: "reviewDeps" });
    runContentReviewSweepMock.mockRejectedValue(new Error("resend exploded with internal details"));
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, runId: "run-1", status: "completed", decision: "CREATE_PLAN", concurrent: false });
    expect(JSON.stringify(body)).not.toContain("resend");
    expect(runSweepMock).toHaveBeenCalledTimes(1);
  });

  it("26. an authentication failure never runs the content-review sweep", async () => {
    createContentReviewDepsMock.mockReturnValue({ __fake: "reviewDeps" });
    await GET(getRequest("Bearer wrong-secret"));
    expect(createContentReviewDepsMock).not.toHaveBeenCalled();
    expect(runContentReviewSweepMock).not.toHaveBeenCalled();
  });

  it("27. runs the email-authorized publication recovery sweep last, after the continuation sweep", async () => {
    const order: string[] = [];
    runMarketingCycleMock.mockImplementation(async () => {
      order.push("cycle");
      return { run: { id: "run-1", status: "completed", decision: "NO_ACTION" } };
    });
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });
    runSweepMock.mockImplementation(async () => {
      order.push("continuation");
      return { considered: 0, outcomes: [] };
    });
    createPublicationDepsMock.mockReturnValue({ __fake: "pubDeps" });
    runPublicationSweepMock.mockImplementation(async () => {
      order.push("publication");
      return { outcomes: ["published"] };
    });

    const response = await GET(getRequest(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(runPublicationSweepMock).toHaveBeenCalledWith({ __fake: "pubDeps" });
    expect(order.slice(-2)).toEqual(["continuation", "publication"]);
    expect(runMarketingCycleMock).toHaveBeenCalledTimes(1);
  });

  it("28. a publication recovery failure never changes the cron response", async () => {
    runMarketingCycleMock.mockResolvedValue({ run: { id: "run-1", status: "completed", decision: "NO_ACTION" } });
    createPublicationDepsMock.mockReturnValue({ __fake: "pubDeps" });
    runPublicationSweepMock.mockRejectedValue(new Error("meta exploded with internal details"));

    const response = await GET(getRequest(`Bearer ${SECRET}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, runId: "run-1", status: "completed", decision: "NO_ACTION", concurrent: false });
  });

  it("29. an authentication failure never runs publication recovery", async () => {
    createPublicationDepsMock.mockReturnValue({ __fake: "pubDeps" });
    await GET(getRequest("Bearer wrong-secret"));
    expect(createPublicationDepsMock).not.toHaveBeenCalled();
    expect(runPublicationSweepMock).not.toHaveBeenCalled();
  });

  it("20. an authentication failure never runs the sweep", async () => {
    createContinuationDepsMock.mockReturnValue({ __fake: "deps" });
    await GET(getRequest("Bearer wrong-secret"));
    expect(runSweepMock).not.toHaveBeenCalled();
    expect(createContinuationDepsMock).not.toHaveBeenCalled();
  });
});

describe("vercel.json cron configuration", () => {
  it("contains exactly the SolarDesk daily wake — no other cron entries", async () => {
    const vercelConfig = (await import("@/vercel.json")).default as {
      crons: { path: string; schedule: string }[];
    };

    expect(vercelConfig.crons).toHaveLength(1);
    expect(vercelConfig.crons[0].path).toBe("/api/cron/marketing-cycle");
    expect(vercelConfig.crons[0].schedule).toBe("0 13 * * *");
  });
});
