import { describe, it, expect, vi, beforeEach } from "vitest";

// Thin route-adaptor tests for app/api/email-actions/{inspect,confirm}.
// Domain behavior is covered by tests/emailActions.test.ts; these prove
// only: POST-only, bounded JSON body parsing, delegation, no-store/
// no-referrer headers, and that errors never echo the token back.

const { inspectMock, confirmMock } = vi.hoisted(() => ({ inspectMock: vi.fn(), confirmMock: vi.fn() }));

vi.mock("@/lib/agent/emailActions", () => ({ inspectEmailAction: inspectMock, confirmEmailAction: confirmMock }));
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
    expect(confirmMock).toHaveBeenCalledWith({ __fake: "db" }, TOKEN);
    expect(await response.json()).toEqual({ result: "applied", context: {} });
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
