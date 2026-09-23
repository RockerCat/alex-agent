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
    ctaUrl: draft.cta_url,
    targetDate: draft.target_date,
  };
}

export interface RegenerateOutcome {
  status: "revised" | "blocked_on_question" | "failed" | "concurrent";
  draft?: ContentDraftRow;
  questionId?: string;
  message?: string;
  /**
   * True only when status === "failed" because the Budget Guard blocked
   * the call. Callers that own an agent_runs row (regenerateDraftContent,
   * runMarketingCycle's blocked-work resume step) use this to record a
   * "skipped / BUDGET_BLOCKED" run instead of a generic failure, without
   * changing the outward-facing status contract other callers rely on.
   */
  budgetBlocked?: boolean;
  /**
   * True only when status === "failed" because a version-guarded call
   * (expectedVersion) found the draft no longer at that version /
   * pending_approval — before any AI spend, or at persist time if the
   * draft was approved/rejected/revised while the Executor was running.
   */
  staleVersion?: boolean;
}

const STALE_AT_PERSIST_MESSAGE =
  "The draft changed (approved, rejected, or revised) while this revision was being generated; the revision was discarded.";

/**
 * Generate-validate-persist loop for turning a draft (blocked placeholder
 * or existing pending_approval draft) into a new version. Deliberately
 * does not touch agent_runs at all — it is attributed to whichever run
 * the caller already owns, whether that run was acquired just for this
 * call (regenerateDraftContent below) or is an in-progress marketing
 * cycle that is resuming leftover blocked work
 * (lib/agent/runtime.ts::runMarketingCycle). Errors propagate to the
 * caller rather than being swallowed here, so a technical failure never
 * silently marks a draft as anything other than untouched/still
 * resumable — the caller's own try/catch decides how to record it.
 */
export async function resumeDraftCore(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  budgetGuard: BudgetGuard;
  agentRunId: string;
  draft: ContentDraftRow;
  feedbackCategory?: FeedbackCategory;
  feedbackNote?: string | null;
  factCorrection?: string;
  /**
   * Version-guarded mode (see requestRevision): every draft write below
   * becomes a compare-and-set on (version = expectedVersion, status =
   * pending_approval), so an approve/reject that lands while the
   * Executor is running is never overwritten. Omitted → unchanged
   * legacy behavior for every existing caller.
   */
  expectedVersion?: number;
}): Promise<RegenerateOutcome> {
  const { db, aiClient, budgetGuard, agentRunId, draft, expectedVersion } = params;
  const guarded = expectedVersion !== undefined;

  const context = await loadAgentContext(db, draft.brand as "solardesk");
  const brief = draftToBrief(draft);

  const revisionInstruction: RevisionInstruction | undefined = params.feedbackCategory
    ? {
        category: params.feedbackCategory,
        note: params.feedbackNote ?? null,
        previousContent: {
          title: draft.title,
          hook: draft.hook,
          slides: draft.body?.slides ?? null,
          caption: draft.caption,
          cta: draft.cta_text,
          visualDirection: draft.visual_direction,
          hashtags: draft.hashtags ?? null,
        },
      }
    : undefined;

  let attempt = 0;
  let correctiveNote: string | undefined;

  while (attempt < MAX_EXECUTOR_RETRIES) {
    attempt += 1;

    const budgetCheck = await budgetGuard.checkBeforeCall({
      agentRunId,
      model: env.executorModel(),
      approxInputTokens: estimateExecutorInputTokens(context),
      approxMaxOutputTokens: 2000,
    });
    if (!budgetCheck.allowed) {
      return { status: "failed", message: budgetCheck.reason, budgetBlocked: true };
    }

    const executorResult = await callExecutor(
      aiClient,
      context,
      brief,
      revisionInstruction,
      correctiveNote ?? params.factCorrection
    );
    await budgetGuard.recordUsage({
      agentRunId,
      brand: draft.brand,
      operation: "executor",
      model: executorResult.model,
      usage: executorResult.usage,
    });

    if (executorResult.incomplete) {
      // Same guard as executeContentBrief in runtime.ts: the Responses
      // API flagged this call incomplete — usage is already recorded
      // above, but nothing about this result may be validated or
      // persisted. Retry within the existing bounded policy.
      correctiveNote = `Your previous response was cut off before completing (reason: ${executorResult.incomplete.reason}). Write shorter, self-contained sentences that comfortably fit within each field's length limit — never let a sentence run past the limit and get cut off mid-thought.`;
      continue;
    }

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
        return { status: "failed", message: qError?.message };
      }

      if (guarded) {
        const { data: blocked, error: blockError } = await db
          .from("content_drafts")
          .update({ status: "revision_requested", blocked_on_question_id: question.id })
          .eq("id", draft.id)
          .eq("status", "pending_approval")
          .eq("version", expectedVersion)
          .select("id")
          .maybeSingle();
        if (blockError || !blocked) {
          // The draft moved on while the Executor ran — this question no
          // longer blocks anything, so it must not linger as open work.
          await db.from("agent_questions").update({ status: "dismissed" }).eq("id", question.id).eq("status", "open");
          return blockError
            ? { status: "failed", message: blockError.message }
            : { status: "failed", staleVersion: true, message: STALE_AT_PERSIST_MESSAGE };
        }
        return { status: "blocked_on_question", questionId: question.id };
      }

      await db
        .from("content_drafts")
        .update({ status: "revision_requested", blocked_on_question_id: question.id })
        .eq("id", draft.id);

      return { status: "blocked_on_question", questionId: question.id };
    }

    if (validation.valid && validation.output) {
      const output = validation.output;
      const nextVersion = draft.version + 1;

      const revisionRow = {
        draft_id: draft.id,
        version: nextVersion,
        title: output.title,
        hook: output.hook,
        body: { slides: output.slides },
        caption: output.caption,
        cta_text: output.cta,
        visual_direction: output.visualDirection,
        hashtags: output.hashtags,
        source: "executor" as const,
        feedback_category: params.feedbackCategory ?? null,
        feedback_note: params.feedbackNote ?? null,
        created_by_run: agentRunId,
      };
      const draftUpdate = {
        version: nextVersion,
        status: "pending_approval" as const,
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
      };

      if (guarded) {
        // Compare-and-set the draft FIRST, so a draft that moved on
        // mid-generation never gets an orphan content_revisions row for
        // a version that was never materialized.
        const { data: updatedDraft, error: updateError } = await db
          .from("content_drafts")
          .update(draftUpdate)
          .eq("id", draft.id)
          .eq("status", "pending_approval")
          .eq("version", expectedVersion)
          .select("*")
          .maybeSingle();
        if (updateError) return { status: "failed", message: updateError.message };
        if (!updatedDraft) return { status: "failed", staleVersion: true, message: STALE_AT_PERSIST_MESSAGE };

        const { error: revisionError } = await db.from("content_revisions").insert(revisionRow);
        if (revisionError) {
          // The draft (the authoritative current content) is already
          // revised; only its history snapshot failed — surfaced, not
          // silently ignored, but not reported as an unrevised draft.
          console.error(`content_revisions snapshot for draft v${nextVersion} failed:`, revisionError.message);
        }
        return { status: "revised", draft: updatedDraft };
      }

      await db.from("content_revisions").insert(revisionRow);

      const { data: updatedDraft, error: updateError } = await db
        .from("content_drafts")
        .update(draftUpdate)
        .eq("id", draft.id)
        .select("*")
        .single();

      if (updateError || !updatedDraft) {
        return { status: "failed", message: updateError?.message };
      }

      return { status: "revised", draft: updatedDraft };
    }

    correctiveNote = `The previous draft was rejected: ${validation.errors.join("; ")}. Produce a corrected version.`;
  }

  return { status: "failed", message: "Executor could not produce a valid revision within the retry budget." };
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

/**
 * Shared entry point used both by human-initiated revisions (Approvals
 * UI, via requestRevision) and by automatic resumption when a blocking
 * question gets answered (lib/agent/questions.ts::answerQuestion).
 * Acquires its own brand-scoped lock, delegates the actual work to
 * resumeDraftCore, and finalizes that lock's run based on the outcome.
 */
export async function regenerateDraftContent(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  draft: ContentDraftRow;
  feedbackCategory?: FeedbackCategory;
  feedbackNote?: string | null;
  factCorrection?: string;
  /** Forwarded to resumeDraftCore — see its doc comment. */
  expectedVersion?: number;
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
    const budgetGuard = new BudgetGuard(db);
    const outcome = await resumeDraftCore({
      db,
      aiClient,
      budgetGuard,
      agentRunId: lockRun.id,
      draft,
      feedbackCategory: params.feedbackCategory,
      feedbackNote: params.feedbackNote,
      factCorrection: params.factCorrection,
      expectedVersion: params.expectedVersion,
    });

    if (outcome.budgetBlocked) {
      await db
        .from("agent_runs")
        .update({
          status: "skipped",
          decision: "BUDGET_BLOCKED",
          summary: outcome.message ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", lockRun.id);
      return outcome;
    }

    if (outcome.status === "blocked_on_question") {
      await finalizeRun(db, lockRun.id, "completed", undefined, "Revision blocked on a factual question.");
      return outcome;
    }

    if (outcome.status === "revised") {
      await finalizeRun(db, lockRun.id, "completed", undefined, `Created revision v${outcome.draft!.version}.`);
      return outcome;
    }

    await finalizeRun(db, lockRun.id, "failed", outcome.message ?? "unknown");
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRun(db, lockRun.id, "failed", message);
    return { status: "failed", message };
  }
}

export async function requestRevision(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  draftId: string;
  category: FeedbackCategory;
  note?: string | null;
  /**
   * When provided, the revision only proceeds (and only persists) if the
   * draft is still at exactly this version and pending_approval —
   * checked before any lock/AI spend, and again as a compare-and-set at
   * persist time. Omitted → unchanged legacy behavior.
   */
  expectedVersion?: number;
}): Promise<RegenerateOutcome> {
  const { db, aiClient, draftId, category, note, expectedVersion } = params;

  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    return { status: "failed", message: "Invalid expected draft version." };
  }

  const { data: draft, error } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (error || !draft) {
    return { status: "failed", message: "Draft not found." };
  }
  if (draft.status !== "pending_approval") {
    return { status: "failed", message: `Draft is in status "${draft.status}" and cannot be revised right now.` };
  }
  if (expectedVersion !== undefined && draft.version !== expectedVersion) {
    return {
      status: "failed",
      staleVersion: true,
      message: `Draft is now at version ${draft.version}; changes requested for version ${expectedVersion} were not applied.`,
    };
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
    expectedVersion,
  });
}
