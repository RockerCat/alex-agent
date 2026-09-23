import { describe, it, expect, vi, beforeEach } from "vitest";

// Thin route-adaptor tests for app/api/email-actions/{inspect,confirm}.
// Domain behavior is covered by tests/emailActions.test.ts; these prove
// only: POST-only, bounded JSON body parsing, delegation, no-store/
// no-referrer headers, and that errors never echo the token back.

const { inspectMock, confirmMock, afterMock, runContinuationMock, runAutoPublicationMock } = vi.hoisted(() => ({
  inspectMock: vi.fn(),
  confirmMock: vi.fn(),
  afterMock: vi.fn(),
  runContinuationMock: vi.fn(),
  runAutoPublicationMock: vi.fn(),
}));

vi.mock("@/lib/agent/postApprovalPublication", () => ({ runAutoPublicationSafely: runAutoPublicationMock }));

vi.mock("@/lib/agent/emailActions", () => ({ inspectEmailAction: inspectMock, confirmEmailAction: confirmMock }));
vi.mock("@/lib/agent/postApprovalContinuation", () => ({ runContinuationSafely: runContinuationMock }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: afterMock }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ __fake: "db" }) }));

import * as inspectRoute from "@/app/api/email-actions/inspect/route";
import * as confirmRoute from "@/app/api/email-actions/confirm/route";

const TOKEN = "T".repeat(43);

function post(body: string) {
  return new Request("https://agent.alexsosa.me/api/email-actions/x", { method: "POST", body, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  inspectMock.mockReset();
  confirmMock.mockReset();
  afterMock.mockReset();
  runContinuationMock.mockReset();
  runAutoPublicationMock.mockReset();
});

describe("email action routes", () => {
  it("exposes POST only — there is no GET handler that could decide anything", () => {
    expect(Object.keys(inspectRoute)).toEqual(["POST"]);
    expect(Object.keys(confirmRoute)).toEqual(["POST"]);
  });

  it("inspect delegates the body token and returns no-store/no-referrer headers", async () => {
    inspectMock.mockResolvedValue({ state: "ready", context: {} });
    const response = await inspectRoute.POST(post(JSON.stringify({ token: TOKEN })));
    expect(inspectMock).toHaveBeenCalledWith({ __fake: "db" }, TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({ state: "ready", context: {} });
  });

  it("confirm delegates the body token", async () => {
    confirmMock.mockResolvedValue({ result: "applied", context: {} });
    const response = await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));
    expect(confirmMock).toHaveBeenCalledWith({ __fake: "db" }, TOKEN, undefined, expect.objectContaining({ onApplied: expect.any(Function) }));
    expect(await response.json()).toEqual({ result: "applied", context: {} });
  });

  it("an applied approve_draft schedules the continuation post-response — the response never waits on it", async () => {
    confirmMock.mockImplementation(async (_db, _token, _now, options) => {
      options.onApplied({ action: "approve_draft", subjectType: "content_draft", subjectId: "draft-uuid", subjectVersion: 1 });
      return { result: "applied", context: {} };
    });
    // A continuation that would never finish: the response must still return.
    runContinuationMock.mockReturnValue(new Promise(() => {}));

    const response = await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));

    expect(response.status).toBe(200);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runContinuationMock).not.toHaveBeenCalled(); // scheduled, not run inline
    void afterMock.mock.calls[0][0](); // run the scheduled work (it never settles here, by design)
    expect(runContinuationMock).toHaveBeenCalledWith("draft-uuid");
    // Internal ids never reach the public response.
    expect(JSON.stringify(await response.json())).not.toContain("draft-uuid");
  });

  it("an applied approve_asset schedules automatic publication of exactly that asset post-response — never inline", async () => {
    confirmMock.mockImplementation(async (_db, _token, _now, options) => {
      options.onApplied({ action: "approve_asset", subjectType: "content_asset", subjectId: "asset-uuid", subjectVersion: 3 });
      return { result: "applied", context: {} };
    });
    runAutoPublicationMock.mockReturnValue(new Promise(() => {})); // Meta never answers: the response must still return

    const response = await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));

    expect(response.status).toBe(200);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runAutoPublicationMock).not.toHaveBeenCalled();
    void afterMock.mock.calls[0][0]();
    expect(runAutoPublicationMock).toHaveBeenCalledWith("asset-uuid");
    expect(runContinuationMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("asset-uuid");
  });

  it("approve_draft never publishes, and reject_draft schedules nothing", async () => {
    confirmMock.mockImplementationOnce(async (_db, _token, _now, options) => {
      options.onApplied({ action: "approve_draft", subjectType: "content_draft", subjectId: "d", subjectVersion: 1 });
      return { result: "applied", context: {} };
    });
    await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));
    void afterMock.mock.calls[0][0]();
    expect(runAutoPublicationMock).not.toHaveBeenCalled();

    afterMock.mockReset();
    confirmMock.mockImplementationOnce(async (_db, _token, _now, options) => {
      options.onApplied({ action: "reject_draft", subjectType: "content_draft", subjectId: "d", subjectVersion: 1 });
      return { result: "applied", context: {} };
    });
    await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("a non-applied confirmation schedules nothing", async () => {
    confirmMock.mockResolvedValue({ result: "stale", context: {} });
    await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("rejects malformed, missing, and oversized bodies without calling the domain", async () => {
    for (const body of ["", "not json", JSON.stringify({}), JSON.stringify({ token: 5 }), JSON.stringify({ token: "x".repeat(2000) })]) {
      expect((await confirmRoute.POST(post(body))).status).toBe(400);
      expect((await inspectRoute.POST(post(body))).status).toBe(400);
    }
    expect(confirmMock).not.toHaveBeenCalled();
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it("never echoes the token or error details on an unexpected failure", async () => {
    confirmMock.mockRejectedValue(new Error(`db exploded for ${TOKEN}`));
    const response = await confirmRoute.POST(post(JSON.stringify({ token: TOKEN })));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("exploded");
  });
});
