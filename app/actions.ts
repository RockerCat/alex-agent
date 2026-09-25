"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireSession } from "@/lib/supabase/server";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { approveDraft, rejectDraft } from "@/lib/agent/approvals";
import { requestRevision } from "@/lib/agent/revision";
import { answerQuestion } from "@/lib/agent/questions";
import { generateAsset, approveAsset } from "@/lib/agent/assetGenerator";
import { requestAssetChanges } from "@/lib/agent/assetRevision";
import { SupabaseAssetStorage } from "@/lib/agent/assetStorage";
import { runRegeneratedAssetReviewSafely } from "@/lib/agent/postApprovalContinuation";
import { OpenAiImageGenerationClient } from "@/lib/agent/imageGenerationClient";
import { publishAssetToFacebook, publishAssetToInstagram } from "@/lib/agent/publish";
import { MetaGraphFacebookClient } from "@/lib/agent/facebookClient";
import { MetaGraphInstagramClient } from "@/lib/agent/instagramClient";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { SUPPORTED_BRANDS, type FeedbackCategory, type SupportedBrand } from "@/lib/agent/constants";

async function assertAuthorized() {
  const user = await requireSession();
  if (!user) {
    throw new Error("Not authorized.");
  }
}

export async function runMarketingCycleAction() {
  await assertAuthorized();
  const db = supabaseAdmin();
  const aiClient = new OpenAiClient();
  await runMarketingCycle({ db, aiClient, brand: "solardesk", trigger: "manual" });
  revalidatePath("/dashboard");
  revalidatePath("/approvals");
  revalidatePath("/questions");
}

function isSupportedBrand(value: string): value is SupportedBrand {
  return (SUPPORTED_BRANDS as readonly string[]).includes(value);
}

/**
 * Powers Dashboard "Today"/"Daily avg." (components/DailySpend.tsx).
 * The boundaries are computed in the caller's browser (its real local
 * calendar day/month start) and passed in — this action never guesses
 * a timezone itself, so the same brand-scoped read works unchanged for
 * a future MiPadel.Club/Odentia dashboard. Read-only, display-only:
 * never touches Budget Guard enforcement (which stays global).
 */
export async function getBrandSpendSummaryAction(params: {
  brand: string;
  todayStartIso: string;
  monthStartIso: string;
}): Promise<{ todayUsd: number; monthToDateUsd: number } | { error: string }> {
  await assertAuthorized();

  if (!isSupportedBrand(params.brand)) {
    return { error: "Unsupported brand." };
  }
  if (Number.isNaN(Date.parse(params.todayStartIso)) || Number.isNaN(Date.parse(params.monthStartIso))) {
    return { error: "Invalid date boundary." };
  }

  const db = supabaseAdmin();
  const budgetGuard = new BudgetGuard(db);
  const [todayUsd, monthToDateUsd] = await Promise.all([
    budgetGuard.getBrandSpendSince(params.brand, params.todayStartIso),
    budgetGuard.getBrandSpendSince(params.brand, params.monthStartIso),
  ]);
  return { todayUsd, monthToDateUsd };
}

export async function approveDraftAction(draftId: string) {
  await assertAuthorized();
  const result = await approveDraft(supabaseAdmin(), draftId);
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${draftId}`);
  revalidatePath("/dashboard");
  return result;
}

export async function rejectDraftAction(draftId: string) {
  await assertAuthorized();
  const result = await rejectDraft(supabaseAdmin(), draftId);
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${draftId}`);
  revalidatePath("/dashboard");
  return result;
}

export async function requestRevisionAction(
  draftId: string,
  category: FeedbackCategory,
  note: string
) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const aiClient = new OpenAiClient();
  const result = await requestRevision({ db, aiClient, draftId, category, note: note || null });
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${draftId}`);
  revalidatePath("/questions");
  revalidatePath("/dashboard");
  return result;
}

export async function answerQuestionAction(questionId: string, answer: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const aiClient = new OpenAiClient();
  const result = await answerQuestion({ db, aiClient, questionId, answer });
  revalidatePath("/questions");
  revalidatePath("/approvals");
  revalidatePath("/dashboard");
  return result;
}

// Manual-only: this action exists solely so Alex can explicitly click
// "Generate Asset" / "Regenerate" on an eligible approved image_post.
// It is never invoked from runMarketingCycleAction or
// approveDraftAction above — see tests/assetGenerator.test.ts's
// "no automatic generation" suite for the enforced guarantee.
//
// aiClient/imageGenerationClient are always supplied here (production
// posture): the Visual Director only runs for first-time generation
// (generateAsset() internally treats Regenerate as always zero-AI-cost
// regardless), and imageGenerationClient is only ever actually called
// when OPENAI_IMAGE_MODEL is configured — see
// lib/agent/imageGenerationClient.ts's capability gating.
export async function generateAssetAction(draftId: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const storage = new SupabaseAssetStorage(db);
  const aiClient = new OpenAiClient();
  const imageGenerationClient = new OpenAiImageGenerationClient();
  const result = await generateAsset({ db, storage, draftId, aiClient, imageGenerationClient });
  revalidatePath(`/approvals/${draftId}`);
  // A successfully generated/regenerated asset of an email-lifecycle
  // draft gets its finished-publication review email now, post-response,
  // through the canonical continuation — not a second email path, and the
  // same email the next cron sweep would otherwise send. A delivery
  // failure never touches the new asset; the sweep retries the email
  // without regenerating.
  if (result.status === "success") {
    after(() => runRegeneratedAssetReviewSafely(draftId));
  }
  return result;
}

export async function approveAssetAction(assetId: string, draftId: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const result = await approveAsset(db, assetId);
  revalidatePath(`/approvals/${draftId}`);
  return result;
}

// Manual-only, same posture as generateAssetAction: exists solely so
// Alex can explicitly submit free-text visual feedback ("Request
// Changes") on the current image_post asset. Never invoked from
// runMarketingCycleAction or approveDraftAction.
export async function requestAssetChangesAction(draftId: string, feedback: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const storage = new SupabaseAssetStorage(db);
  const aiClient = new OpenAiClient();
  const result = await requestAssetChanges({ db, storage, aiClient, draftId, feedback });
  revalidatePath(`/approvals/${draftId}`);
  return result;
}

// Manual-only, Facebook-only (AlexAgent v0.2 checkpoint 1): exists
// solely so Alex can explicitly click "Publish to Facebook" on a
// Ready-to-publish image_post asset. Never invoked automatically —
// there is no cron/heartbeat/autopublish path anywhere in this app.
// All eligibility/idempotency checks happen server-side in
// lib/agent/publish.ts; the UI confirmation step is a courtesy, not
// the safety boundary.
export async function publishAssetToFacebookAction(draftId: string, assetId: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const storage = new SupabaseAssetStorage(db);
  const facebookClient = new MetaGraphFacebookClient();
  const result = await publishAssetToFacebook({ db, storage, facebookClient, draftId, assetId });
  revalidatePath(`/approvals/${draftId}`);
  return result;
}

// Manual-only, Instagram-only (Instagram publishing readiness
// checkpoint): exists solely so Alex can explicitly click "Publish to
// Instagram" on a Ready-to-publish image_post asset. Never invoked
// automatically — same posture as publishAssetToFacebookAction above.
// All eligibility/idempotency checks happen server-side in
// lib/agent/publish.ts; this action only constructs the real
// dependencies (Supabase admin client, asset storage, the existing
// MetaGraphInstagramClient, which reads META_INSTAGRAM_ACCESS_TOKEN /
// META_INSTAGRAM_ACCOUNT_ID from env internally) and forwards the
// result — it never touches the token itself.
export async function publishAssetToInstagramAction(draftId: string, assetId: string) {
  await assertAuthorized();
  const db = supabaseAdmin();
  const storage = new SupabaseAssetStorage(db);
  const instagramClient = new MetaGraphInstagramClient();
  const result = await publishAssetToInstagram({ db, storage, instagramClient, draftId, assetId });
  revalidatePath(`/approvals/${draftId}`);
  return result;
}

export async function updateSettingsAction(formData: FormData) {
  await assertAuthorized();
  const db = supabaseAdmin();

  const monthlyBudget = Number(formData.get("monthly_budget_usd"));
  const safetyReserve = Number(formData.get("safety_reserve_usd"));
  const perRunBudget = Number(formData.get("per_run_budget_usd"));
  const solardeskEnabled = formData.get("solardesk_enabled") === "on";

  if (!Number.isFinite(monthlyBudget) || monthlyBudget < 0) throw new Error("Invalid monthly budget.");
  if (!Number.isFinite(safetyReserve) || safetyReserve < 0) throw new Error("Invalid safety reserve.");
  if (!Number.isFinite(perRunBudget) || perRunBudget < 0) throw new Error("Invalid per-run budget.");
  if (safetyReserve >= monthlyBudget) throw new Error("Safety reserve must be smaller than the monthly budget.");

  const { error } = await db
    .from("agent_settings")
    .update({
      monthly_budget_usd: monthlyBudget,
      safety_reserve_usd: safetyReserve,
      per_run_budget_usd: perRunBudget,
      solardesk_enabled: solardeskEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq("singleton", true);

  if (error) throw new Error(error.message);

  revalidatePath("/settings");
  revalidatePath("/dashboard");
}
