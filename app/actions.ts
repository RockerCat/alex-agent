"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireSession } from "@/lib/supabase/server";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { approveDraft, rejectDraft } from "@/lib/agent/approvals";
import { requestRevision } from "@/lib/agent/revision";
import { answerQuestion } from "@/lib/agent/questions";
import type { FeedbackCategory } from "@/lib/agent/constants";

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
