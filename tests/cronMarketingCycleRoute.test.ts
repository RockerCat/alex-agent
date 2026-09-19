import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Autonomy v1 Phase 1A — tests the authenticated headless Route Handler
// (app/api/cron/marketing-cycle/route.ts) in isolation: no real Supabase
// or OpenAI client is ever constructed here. runMarketingCycle() itself
// is already covered by its own test suites (marketingCycleExpiry.test.ts,
// the acceptance suite, etc.) — this file only proves the Route
// Handler's own job: authenticate, then forward to that exact function
// with the exact expected arguments, and translate its result into a
// safe response.

const { runMarketingCycleMock } = vi.hoisted(() => ({ runMarketingCycleMock: vi.fn() }));

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

import { POST } from "@/app/api/cron/marketing-cycle/route";

const SECRET = "test-cron-secret-do-not-use-in-prod";
const HEADER = "x-alexagent-cron-secret";

function postRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/marketing-cycle", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/marketing-cycle", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    runMarketingCycleMock.mockReset();
    process.env.ALEXAGENT_CRON_SECRET = SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. missing server-side ALEXAGENT_CRON_SECRET fails closed and never invokes the runtime", async () => {
    delete process.env.ALEXAGENT_CRON_SECRET;

    const response = await POST(postRequest({ [HEADER]: SECRET }));

    expect(response.status).toBe(503);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("2. a missing auth header is rejected and never invokes the runtime", async () => {
    const response = await POST(postRequest());

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("3. an invalid auth header is rejected and never invokes the runtime", async () => {
    const response = await POST(postRequest({ [HEADER]: "wrong-secret" }));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("4. an invalid header of a different length than the real secret is rejected safely", async () => {
    const response = await POST(postRequest({ [HEADER]: "short" }));

    expect(response.status).toBe(401);
    expect(runMarketingCycleMock).not.toHaveBeenCalled();
  });

  it("5. a valid secret invokes the existing runtime with brand: solardesk, trigger: scheduled", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    await POST(postRequest({ [HEADER]: SECRET }));

    expect(runMarketingCycleMock).toHaveBeenCalledTimes(1);
    const call = runMarketingCycleMock.mock.calls[0][0];
    expect(call.brand).toBe("solardesk");
    expect(call.trigger).toBe("scheduled");
    expect(call.db).toBeDefined();
    expect(call.aiClient).toBeDefined();
  });

  it("6. a successful wake returns a safe, minimal JSON response", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    const response = await POST(postRequest({ [HEADER]: SECRET }));
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

  it("7. a concurrent/skipped result is represented safely", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-2", status: "skipped", decision: null },
      concurrent: true,
    });

    const response = await POST(postRequest({ [HEADER]: SECRET }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.concurrent).toBe(true);
    expect(body.status).toBe("skipped");
  });

  it("8. a runtime failure returns a safe server error without leaking internal details", async () => {
    runMarketingCycleMock.mockRejectedValue(new Error("service_role key rejected by postgres at 10.0.0.4:5432"));

    const response = await POST(postRequest({ [HEADER]: SECRET }));
    const body = await response.json();
    const bodyText = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(bodyText).not.toContain("10.0.0.4");
    expect(bodyText).not.toContain("postgres");
  });

  it("9. the response never echoes the configured secret", async () => {
    runMarketingCycleMock.mockResolvedValue({
      run: { id: "run-1", status: "completed", decision: "NO_ACTION" },
    });

    const response = await POST(postRequest({ [HEADER]: SECRET }));
    const bodyText = JSON.stringify(await response.json());

    expect(bodyText).not.toContain(SECRET);
  });
});
