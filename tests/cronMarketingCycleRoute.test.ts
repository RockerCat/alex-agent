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

const { runMarketingCycleMock, notifyAttentionIfNeededMock } = vi.hoisted(() => ({
  runMarketingCycleMock: vi.fn(),
  notifyAttentionIfNeededMock: vi.fn(),
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
