import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, AgentRunRow, RunTrigger, RunKind } from "@/lib/types/database";
import type { AiClient } from "@/lib/agent/aiClient";
import type { SupportedBrand } from "@/lib/agent/constants";
import { MAX_CONTENT_PER_CYCLE, MAX_EXECUTOR_RETRIES, MAX_PLANNER_CALLS_PER_RUN } from "@/lib/agent/constants";
import { loadAgentContext } from "@/lib/agent/contextLoader";
import { runPreflight } from "@/lib/agent/preflight";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { callPlanner, estimatePlannerInputTokens } from "@/lib/agent/planner";
import { validatePlannerOutput } from "@/lib/agent/planValidator";
import { callExecutor, estimateExecutorInputTokens } from "@/lib/agent/executor";
import { validateDraft } from "@/lib/agent/draftValidator";
import type { ContentBrief } from "@/lib/agent/schemas";
import { env } from "@/lib/env";
import { isUniqueViolation, recoverStaleRuns } from "@/lib/agent/runLock";

async function acquireRunLock(
  db: SupabaseClient<Database>,
  brand: string,
  trigger: RunTrigger,
  kind: RunKind
): Promise<{ run: AgentRunRow | null; concurrent: boolean }> {
  const { data, error } = await db
    .from("agent_runs")
    .insert({ brand, trigger, kind, status: "running" })
    .select("*")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      return { run: null, concurrent: true };
    }
    throw new Error(`Unable to acquire run lock: ${error.message}`);
  }

  return { run: data, concurrent: false };
}

async function finishRun(
  db: SupabaseClient<Database>,
  runId: string,
  fields: Partial<AgentRunRow>
): Promise<AgentRunRow> {
  const { data, error } = await db
    .from("agent_runs")
    .update({ ...fields, completed_at: new Date().toISOString() })
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw new Error(`Unable to finalize run: ${error.message}`);
  return data;
}

export interface MarketingCycleResult {
  run: AgentRunRow;
  concurrent?: boolean;
}

/**
 * The single AlexAgent entry point (spec section 6): runMarketingCycle.
 * "Run Marketing Cycle" means wake up, inspect state, and decide — not
 * "generate content now". A fully successful run may create nothing.
 */
export async function runMarketingCycle(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  brand: SupportedBrand;
  trigger?: RunTrigger;
}): Promise<MarketingCycleResult> {
  const { db, aiClient, brand } = params;
  const trigger = params.trigger ?? "manual";

  await recoverStaleRuns(db, brand);

  const { run, concurrent } = await acquireRunLock(db, brand, trigger, "marketing_cycle");
  if (concurrent || !run) {
    const skippedRun = await db
      .from("agent_runs")
      .insert({
        brand,
        trigger,
        kind: "marketing_cycle",
        status: "skipped",
        decision: null,
        summary: "Another SolarDesk marketing cycle is already running. No Planner call was made.",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (skippedRun.error || !skippedRun.data) {
      throw new Error(`Unable to record concurrent-run skip: ${skippedRun.error?.message}`);
    }
    return { run: skippedRun.data, concurrent: true };
  }

  try {
    const { data: settings, error: settingsError } = await db
      .from("agent_settings")
      .select("*")
      .eq("singleton", true)
      .single();
    if (settingsError || !settings) throw new Error(`Unable to load settings: ${settingsError?.message}`);

    const budgetGuard = new BudgetGuard(db);
    const budgetSnapshot = await budgetGuard.getSnapshot();
    const context = await loadAgentContext(db, brand);
    const todayIso = new Date().toISOString().slice(0, 10);

    const preflight = runPreflight({
      context,
      solardeskEnabled: settings.solardesk_enabled,
      budget: budgetSnapshot,
    });

    if (preflight.outcome !== "proceed_to_planner") {
      const decision =
        preflight.outcome === "budget_blocked"
          ? "BUDGET_BLOCKED"
          : preflight.outcome === "blocked_by_question"
            ? "NEEDS_HUMAN_INPUT"
            : preflight.outcome === "wait_for_approval"
              ? "WAIT_FOR_APPROVAL"
              : null;
      const finished = await finishRun(db, run.id, {
        status: "skipped",
        decision,
        summary: preflight.summary,
      });
      return { run: finished };
    }

    // ---- Planner ----
    let plannerAttempt = 0;
    let correctiveNote: string | undefined;
    let validated: ReturnType<typeof validatePlannerOutput> | null = null;

    while (plannerAttempt < MAX_PLANNER_CALLS_PER_RUN) {
      plannerAttempt += 1;

      const estimatedInput = estimatePlannerInputTokens(context);
      const budgetCheck = await budgetGuard.checkBeforeCall({
        agentRunId: run.id,
        model: env.plannerModel(),
        approxInputTokens: estimatedInput,
        approxMaxOutputTokens: 3000,
      });
      if (!budgetCheck.allowed) {
        const finished = await finishRun(db, run.id, {
          status: "skipped",
          decision: "BUDGET_BLOCKED",
          summary: budgetCheck.reason ?? "Budget blocked before Planner call.",
        });
        return { run: finished };
      }

      const plannerResult = await callPlanner(aiClient, context, todayIso, correctiveNote);
      await budgetGuard.recordUsage({
        agentRunId: run.id,
        brand,
        operation: "planner",
        model: plannerResult.model,
        usage: plannerResult.usage,
      });

      validated = validatePlannerOutput(plannerResult.output, context, todayIso);
      if (validated.valid) break;

      correctiveNote = `The previous response was rejected by validation: ${validated.errors.join("; ")}. Correct these issues and respond again with valid structured output.`;
      validated = null;
    }

    if (!validated) {
      const finished = await finishRun(db, run.id, {
        status: "failed",
        decision: null,
        error_code: "planner_validation_failed",
        error_message: correctiveNote ?? "Planner output failed validation after retries.",
        summary: "Planner could not produce a valid decision within the retry budget.",
      });
      return { run: finished };
    }

    const plannerOutput = validated.corrected!;
    const nonFatalNotes = validated.errors; // e.g. clamped content, dropped duplicates

    if (plannerOutput.decision === "NEEDS_HUMAN_INPUT") {
      await db.from("agent_questions").insert({
        brand,
        question: plannerOutput.humanQuestion!.question,
        reason: plannerOutput.humanQuestion!.reason,
        status: "open",
        blocks_progress: true,
        context_run_id: run.id,
      });
      const finished = await finishRun(db, run.id, {
        status: "completed",
        decision: "NEEDS_HUMAN_INPUT",
        summary: plannerOutput.rationale,
      });
      return { run: finished };
    }

    if (plannerOutput.decision === "NO_ACTION" || plannerOutput.decision === "WAIT_FOR_APPROVAL") {
      const finished = await finishRun(db, run.id, {
        status: "completed",
        decision: plannerOutput.decision,
        summary: plannerOutput.rationale,
      });
      return { run: finished };
    }

    // CREATE_PLAN or CONTINUE_EXISTING_PLAN
    let planId: string;
    if (plannerOutput.decision === "CREATE_PLAN") {
      const { data: plan, error: planError } = await db
        .from("marketing_plans")
        .insert({
          brand,
          period_start: validated.periodStart!,
          period_end: validated.periodEnd!,
          primary_objective: plannerOutput.primaryObjective!.type,
          primary_objective_reason: plannerOutput.primaryObjective!.reason,
          primary_objective_success_signal: plannerOutput.primaryObjective!.successSignal,
          supporting_objectives: plannerOutput.supportingObjectives,
          strategy_summary: plannerOutput.strategy!.summary,
          strategy_audience: plannerOutput.strategy!.audience,
          strategy_approach: plannerOutput.strategy!.approach,
          rationale: plannerOutput.rationale,
          status: "active",
          created_by_run: run.id,
        })
        .select("*")
        .single();
      if (planError || !plan) {
        const finished = await finishRun(db, run.id, {
          status: "failed",
          decision: null,
          error_code: "plan_persistence_failed",
          error_message: planError?.message ?? "unknown",
          summary: "Failed to persist the new marketing plan.",
        });
        return { run: finished };
      }
      planId = plan.id;
    } else {
      if (!context.activePlan) {
        const finished = await finishRun(db, run.id, {
          status: "failed",
          decision: null,
          error_code: "no_active_plan",
          error_message: "CONTINUE_EXISTING_PLAN with no active plan in context",
          summary: "Inconsistent state: no active plan to continue.",
        });
        return { run: finished };
      }
      planId = context.activePlan.id;
    }

    const briefs = plannerOutput.content.slice(0, MAX_CONTENT_PER_CYCLE);
    const draftNotes: string[] = [...nonFatalNotes];
    let draftsCreated = 0;

    for (const brief of briefs) {
      const created = await executeContentBrief({
        db,
        aiClient,
        budgetGuard,
        context,
        brand,
        planId,
        runId: run.id,
        brief,
      });
      if (created.created) {
        draftsCreated += 1;
      } else {
        draftNotes.push(created.note);
        if (created.budgetStopped) break;
      }
    }

    const summary = [
      plannerOutput.rationale,
      draftsCreated > 0 ? `Created ${draftsCreated} draft(s) pending approval.` : "No drafts were created.",
      ...draftNotes,
    ].join(" ");

    const finished = await finishRun(db, run.id, {
      status: "completed",
      decision: plannerOutput.decision,
      summary,
    });
    return { run: finished };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finished = await finishRun(db, run.id, {
      status: "failed",
      decision: null,
      error_code: "unexpected_error",
      error_message: message,
      summary: "Marketing cycle failed due to an unexpected error.",
    });
    return { run: finished };
  }
}

async function executeContentBrief(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  budgetGuard: BudgetGuard;
  context: Awaited<ReturnType<typeof loadAgentContext>>;
  brand: string;
  planId: string;
  runId: string;
  brief: ContentBrief;
}): Promise<{ created: boolean; note: string; budgetStopped?: boolean }> {
  const { db, aiClient, budgetGuard, context, brand, planId, runId, brief } = params;

  let attempt = 0;
  let correctiveNote: string | undefined;

  while (attempt < MAX_EXECUTOR_RETRIES) {
    attempt += 1;

    const budgetCheck = await budgetGuard.checkBeforeCall({
      agentRunId: runId,
      model: env.executorModel(),
      approxInputTokens: estimateExecutorInputTokens(context),
      approxMaxOutputTokens: 2000,
    });
    if (!budgetCheck.allowed) {
      return { created: false, note: `Stopped creating drafts: ${budgetCheck.reason}`, budgetStopped: true };
    }

    const executorResult = await callExecutor(
      aiClient,
      context,
      brief,
      undefined,
      correctiveNote
    );
    await budgetGuard.recordUsage({
      agentRunId: runId,
      brand,
      operation: "executor",
      model: executorResult.model,
      usage: executorResult.usage,
    });

    const validation = validateDraft(executorResult.output, brief);

    if (validation.output?.unresolvedFactualGap) {
      // Persist the blocked brief itself (not just the question text) as
      // a content_drafts row in status "draft" — the same mechanism
      // already used for a revision blocked on a factual question (see
      // lib/agent/revision.ts / lib/agent/questions.ts). Without this,
      // the brief's channel/topic/audience/cta/targetDate only ever
      // existed in memory for this one attempt: answering the resulting
      // question had nothing to resume, so the brief was silently lost
      // even though the Planner had originally called for it.
      const { data: placeholderDraft, error: placeholderError } = await db
        .from("content_drafts")
        .insert({
          plan_id: planId,
          brand,
          created_by_run: runId,
          channel: brief.channel,
          content_type: brief.format,
          purpose: brief.purpose,
          topic: brief.topic,
          audience: brief.audience,
          cta: brief.cta,
          target_date: brief.targetDate,
          status: "draft",
          version: 0, // regenerateDraftContent bumps to 1 on the first successful resume, matching normal "v1 = initial content" numbering.
        })
        .select("*")
        .single();

      if (placeholderError || !placeholderDraft) {
        return {
          created: false,
          note: `Skipped "${brief.topic}": executor flagged a factual gap, but the blocked brief could not be persisted (${placeholderError?.message ?? "unknown error"}). A human question was not created either.`,
        };
      }

      const { data: question, error: questionError } = await db
        .from("agent_questions")
        .insert({
          brand,
          question: validation.output.unresolvedFactualGap.question,
          reason: validation.output.unresolvedFactualGap.reason,
          status: "open",
          blocks_progress: false,
          context_run_id: runId,
          context_plan_id: planId,
          context_draft_id: placeholderDraft.id,
        })
        .select("id")
        .single();

      if (questionError || !question) {
        return {
          created: false,
          note: `Skipped "${brief.topic}": executor flagged a factual gap, but the question could not be persisted (${questionError?.message ?? "unknown error"}).`,
        };
      }

      await db
        .from("content_drafts")
        .update({ blocked_on_question_id: question.id })
        .eq("id", placeholderDraft.id);

      return {
        created: false,
        note: `Skipped "${brief.topic}": executor flagged a factual gap and a human question was created. It will resume automatically once answered.`,
      };
    }

    if (validation.valid && validation.output) {
      const output = validation.output;
      const { data: draft, error: draftError } = await db
        .from("content_drafts")
        .insert({
          plan_id: planId,
          brand,
          created_by_run: runId,
          channel: brief.channel,
          content_type: brief.format,
          purpose: brief.purpose,
          topic: brief.topic,
          audience: brief.audience,
          cta: brief.cta,
          target_date: brief.targetDate,
          status: "pending_approval",
          version: 1,
          title: output.title,
          hook: output.hook,
          body: { slides: output.slides },
          caption: output.caption,
          cta_text: output.cta,
          visual_direction: output.visualDirection,
          hashtags: output.hashtags,
        })
        .select("*")
        .single();

      if (draftError || !draft) {
        return { created: false, note: `Failed to persist draft "${brief.topic}": ${draftError?.message}` };
      }

      await db.from("content_revisions").insert({
        draft_id: draft.id,
        version: 1,
        title: output.title,
        hook: output.hook,
        body: { slides: output.slides },
        caption: output.caption,
        cta_text: output.cta,
        visual_direction: output.visualDirection,
        hashtags: output.hashtags,
        source: "initial",
        created_by_run: runId,
      });

      return { created: true, note: "" };
    }

    correctiveNote = `The previous draft was rejected: ${validation.errors.join("; ")}. Produce a corrected version.`;
  }

  return {
    created: false,
    note: `Skipped "${brief.topic}" after ${MAX_EXECUTOR_RETRIES} failed attempt(s).`,
  };
}
