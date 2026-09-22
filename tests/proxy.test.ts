import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// AlexAgent — session-auth middleware (proxy.ts) routing tests. Meta's
// WhatsApp webhook has no AlexAgent browser session, so it must be
// exempt from the /login redirect the same way app/api/cron/* already
// is — this only proves the routing decision; the webhook's own
// verify-token check is covered separately in
// tests/whatsappWebhookRoute.test.ts. Supabase's real network call is
// never made here — createServerClient is mocked.

const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}));

import { proxy } from "@/proxy";

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe("proxy — session-auth routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    getUserMock.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key-for-tests-only";
    delete process.env.OWNER_EMAIL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. an unauthenticated request to /api/webhooks/whatsapp is not redirected to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/api/webhooks/whatsapp"));
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
  });

  it("2. the webhook exemption short-circuits before ever calling Supabase auth", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    await proxy(makeRequest("/api/webhooks/whatsapp"));
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("3. an unauthenticated request to an unrelated protected route is still redirected to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("4. a different /api/webhooks/* path is NOT exempted — no broad prefix bypass", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/api/webhooks/some-other-provider"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("5. the pre-existing /api/cron/ exemption is unaffected", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/api/cron/marketing-cycle"));
    expect(response.status).not.toBe(307);
  });

  it("6. an authenticated request to a protected route is not redirected", async () => {
    getUserMock.mockResolvedValue({ data: { user: { email: "sosa@techtivo.com" } } });
    const response = await proxy(makeRequest("/dashboard"));
    expect(response.status).not.toBe(307);
  });

  it("7. an unauthenticated request to a plain /api route (not exempted) is still redirected", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/api/some-other-endpoint"));
    expect(response.status).toBe(307);
  });

  it("8. an unauthenticated request to /privacy is not redirected to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/privacy"));
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
  });

  it("9. an unrelated protected route (/settings) remains protected after adding /privacy", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/settings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("10. an unauthenticated request to /data-deletion is not redirected to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/data-deletion"));
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
  });

  it("11. /privacy remains public after adding /data-deletion", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/privacy"));
    expect(response.status).not.toBe(307);
  });

  it("12. a representative protected route (/dashboard) remains protected after adding /data-deletion", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("13. a similarly-named unrelated route (/data-deletion-test) is NOT exempted by the /data-deletion addition", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/data-deletion-test"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("14. the existing WhatsApp webhook exemption remains intact after adding /data-deletion", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const response = await proxy(makeRequest("/api/webhooks/whatsapp"));
    expect(response.status).not.toBe(307);
  });
});
