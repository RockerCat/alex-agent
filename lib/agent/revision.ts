import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";
import type { AiClient } from "@/lib/agent/aiClient";
import type { FeedbackCategory } from "@/lib/agent/constants";
import { MAX_EXECUTOR_RETRIES } from "@/lib/agent/constants";
import { loadAgentContext } from "@/lib/agent/contextLoader";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { callExecutor, estimateExecutorInputTokens, type RevisionInstruction } from "@/lib/agent/executor";
import { validateDraft } from "@/lib/agent/draftValidator";
import type { ContentBrief } from "@/lib/agent/schemas";
import { env } from "@/lib/env";
import { isUniqueViolation, recoverStaleRuns } from "@/lib/agent/runLock";

function draftToBrief(draft: ContentDraftRow): ContentBrief {
  return {
    purpose: draft.purpose,
    channel: draft.channel,
    format: draft.content_type,
    topic: draft.topic,
    audience: draft.audience,
    cta: draft.cta,
    targetDate: draft.target_date,
  };
}

export interface RegenerateOutcome {
  status: "revised" | "blocked_on_question" | "failed" | "concurrent";
  draft?: ContentDraftRow;
  questionId?: string;
  message?: string;
}

/**
 * Shared core used both by human-initiated revisions (Approvals UI) and
 * by automatic resumption when a blocking question gets answered. Always
 * preserves the prior version in content_revisions before writing a new
 * one — never overwrites history (spec section 16/17).
 */
export async function regenerateDraftContent(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  draft: ContentDraftRow;
  feedbackCategory?: FeedbackCategory;
  feedbackNote?: string | null;
  factCorrection?: string;
}): Promise<RegenerateOutcome> {
  const { db, aiClient, draft } = params;

  await recoverStaleRuns(db, draft.brand);

  const { data: lockRun, error: lockError } = await db
    .from("agent_runs")
    .insert({ brand: draft.brand, trigger: "manual", kind: "revision", status: "running" })
    .select("*")
    .single();

  if (lockError) {
    if (isUniqueViolation(lockError)) {
      return { status: "concurrent", message: "Another SolarDesk agent operation is already running." };
    }
    return { status: "failed", message: lockError.message };
  }

  try {
    const context = await loadAgentContext(db, draft.brand as "solardesk");
    const budgetGuard = new BudgetGuard(db);
    const brief = draftToBrief(draft);

    const revisionInstruction: RevisionInstruction | undefined = params.feedbackCategory
      ? {
          category: params.feedbackCategory,
          note: params.feedbackNote ?? null,
          previousContent: {
            title: draft.title,
            hook: draft.hook,
            caption: draft.caption,
            cta: draft.cta_text,
          },
        }
      : undefined;

    let attempt = 0;
    let correctiveNote: string | undefined;

    while (attempt < MAX_EXECUTOR_RETRIES) {
      attempt += 1;

      const budgetCheck = await budgetGuard.checkBeforeCall({
        agentRunId: lockRun.id,
        model: env.executorModel(),
        approxInputTokens: estimateExecutorInputTokens(context),
        approxMaxOutputTokens: 2000,
      });
      if (!budgetCheck.allowed) {
        await db
          .from("agent_runs")
          .update({
            status: "skipped",
            decision: "BUDGET_BLOCKED",
            summary: budgetCheck.reason,
            completed_at: new Date().toISOString(),
          })
          .eq("id", lockRun.id);
        return { status: "failed", message: budgetCheck.reason };
      }

      const executorResult = await callExecutor(
        aiClient,
        context,
        brief,
        revisionInstruction,
        correctiveNote ?? params.factCorrection
      );
      await budgetGuard.recordUsage({
        agentRunId: lockRun.id,
        brand: draft.brand,
        operation: "executor",
        model: executorResult.model,
        usage: executorResult.usage,
      });

      const validation = validateDraft(executorResult.output, brief);

      if (validation.output?.unresolvedFactualGap) {
        const { data: question, error: qError } = await db
          .from("agent_questions")
          .insert({
            brand: draft.brand,
            question: validation.output.unresolvedFactualGap.question,
            reason: validation.output.unresolvedFactualGap.reason,
            status: "open",
            blocks_progress: false,
            context_plan_id: draft.plan_id,
            context_draft_id: draft.id,
          })
          .select("id")
          .single();
        if (qError || !question) {
          await finalizeRun(db, lockRun.id, "failed", qError?.message ?? "unknown");
          return { status: "failed", message: qError?.message };
        }

        await db
          .from("content_drafts")
          .update({ status: "revision_requested", blocked_on_question_id: question.id })
          .eq("id", draft.id);

        await finalizeRun(db, lockRun.id, "completed", undefined, "Revision blocked on a factual question.");
        return { status: "blocked_on_question", questionId: question.id };
      }

      if (validation.valid && validation.output) {
        const output = validation.output;
        const nextVersion = draft.version + 1;

        await db.from("content_revisions").insert({
          draft_id: draft.id,
          version: nextVersion,
          title: output.title,
          hook: output.hook,
          body: { slides: output.slides },
          caption: output.caption,
          cta_text: output.cta,
          visual_direction: output.visualDirection,
          hashtags: output.hashtags,
          source: "executor",
          feedback_category: params.feedbackCategory ?? null,
          feedback_note: params.feedbackNote ?? null,
          created_by_run: lockRun.id,
        });

        const { data: updatedDraft, error: updateError } = await db
          .from("content_drafts")
          .update({
            version: nextVersion,
            status: "pending_approval",
            title: output.title,
            hook: output.hook,
            body: { slides: output.slides },
            caption: output.caption,
            cta_text: output.cta,
            visual_direction: output.visualDirection,
            hashtags: output.hashtags,
            blocked_on_question_id: null,
            rejected_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", draft.id)
          .select("*")
          .single();

        if (updateError || !updatedDraft) {
          await finalizeRun(db, lockRun.id, "failed", updateError?.message);
          return { status: "failed", message: updateError?.message };
        }

        await finalizeRun(db, lockRun.id, "completed", undefined, `Created revision v${nextVersion}.`);
        return { status: "revised", draft: updatedDraft };
      }

      correctiveNote = `The previous draft was rejected: ${validation.errors.join("; ")}. Produce a corrected version.`;
    }

    await finalizeRun(db, lockRun.id, "failed", "executor_retries_exhausted");
    return { status: "failed", message: "Executor could not produce a valid revision within the retry budget." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRun(db, lockRun.id, "failed", message);
    return { status: "failed", message };
  }
}

async function finalizeRun(
  db: SupabaseClient<Database>,
  runId: string,
  status: "completed" | "failed",
  errorMessage?: string,
  summary?: string
) {
  await db
    .from("agent_runs")
    .update({
      status,
      error_message: errorMessage ?? null,
      error_code: status === "failed" ? "revision_failed" : null,
      summary: summary ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

export async function requestRevision(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  draftId: string;
  category: FeedbackCategory;
  note?: string | null;
}): Promise<RegenerateOutcome> {
  const { db, aiClient, draftId, category, note } = params;

  const { data: draft, error } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (error || !draft) {
    return { status: "failed", message: "Draft not found." };
  }
  if (draft.status !== "pending_approval") {
    return { status: "failed", message: `Draft is in status "${draft.status}" and cannot be revised right now.` };
  }

  const factCorrection =
    category === "factually_incorrect"
      ? "The previous version contained a claim Alex marked as factually incorrect. Do not restate it. Only include claims directly supported by BRAND.md."
      : undefined;

  return regenerateDraftContent({
    db,
    aiClient,
    draft,
    feedbackCategory: category,
    feedbackNote: note ?? null,
    factCorrection,
  });
}
