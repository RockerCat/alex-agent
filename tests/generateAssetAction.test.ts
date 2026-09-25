import { describe, it, expect, vi, beforeEach } from "vitest";

// Dashboard Generate/Regenerate → immediate finished-publication review
// email (real production incident, 2026-09-25). Tests the server action's
// own wiring in isolation: after a successful generation it schedules the
// canonical post-response review continuation, and never on failure. The
// continuation itself (email-lifecycle scope, idempotency, stale v1 token)
// is covered in postApprovalContinuation.test.ts.

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  requireSession: vi.fn(async () => ({ id: "alex", email: "sosa@techtivo.com" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/agent/aiClient", () => ({ OpenAiClient: class {} }));
vi.mock("@/lib/agent/imageGenerationClient", () => ({ OpenAiImageGenerationClient: class {} }));
vi.mock("@/lib/agent/assetStorage", () => ({ SupabaseAssetStorage: class {} }));
vi.mock("@/lib/agent/assetGenerator", () => ({ generateAsset: vi.fn(), approveAsset: vi.fn() }));
vi.mock("@/lib/agent/postApprovalContinuation", () => ({ runRegeneratedAssetReviewSafely: vi.fn(async () => undefined) }));

import { after } from "next/server";
import { generateAsset } from "@/lib/agent/assetGenerator";
import { runRegeneratedAssetReviewSafely } from "@/lib/agent/postApprovalContinuation";
import { requireSession } from "@/lib/supabase/server";
import { generateAssetAction } from "@/app/actions";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

describe("generateAssetAction — review email continuation", () => {
  beforeEach(() => {
    vi.mocked(after).mockClear();
    vi.mocked(runRegeneratedAssetReviewSafely).mockClear();
    vi.mocked(generateAsset).mockReset();
  });

  it("after a successful (re)generation, schedules the canonical review continuation post-response", async () => {
    const asset = { id: "asset-2", asset_version: 2, status: "pending_review" };
    vi.mocked(generateAsset).mockResolvedValue({ status: "success", asset } as never);

    const result = await generateAssetAction(DRAFT_ID);

    expect(result).toEqual({ status: "success", asset }); // action result unchanged
    expect(after).toHaveBeenCalledTimes(1);
    expect(runRegeneratedAssetReviewSafely).not.toHaveBeenCalled(); // not before the response
    await (vi.mocked(after).mock.calls[0][0] as () => Promise<void>)();
    expect(runRegeneratedAssetReviewSafely).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("schedules nothing when generation did not succeed", async () => {
    for (const status of ["failed", "ineligible", "concurrent"] as const) {
      vi.mocked(generateAsset).mockResolvedValueOnce({ status, message: "x" } as never);
      await generateAssetAction(DRAFT_ID);
    }
    expect(after).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller neither generates nor schedules anything", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null as never);
    await expect(generateAssetAction(DRAFT_ID)).rejects.toThrow("Not authorized.");
    expect(generateAsset).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
});
