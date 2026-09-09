import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { AiClient } from "@/lib/agent/aiClient";
import { regenerateDraftContent, type RegenerateOutcome } from "@/lib/agent/revision";

export interface AnswerQuestionOutcome {
  ok: boolean;
  message?: string;
  resumed?: RegenerateOutcome;
}

/**
 * Alex answers a business/product question through the /questions UI
 * (spec section 18). The answer becomes available to the next Planner
 * run via the Context Loader; if the question was blocking a specific
 * draft, that draft is resumed automatically so Alex never has to start
 * a chat to unblock it. This covers two cases that both leave a
 * content_drafts row with blocked_on_question_id set: a pending draft
 * blocked on a revision (factually_incorrect feedback), and a brief the
 * Planner originally called for that the Executor could not complete
 * without this fact (see the unresolvedFactualGap branch in
 * lib/agent/runtime.ts) — in the latter case the draft starts in status
 * "draft" with no generated content yet, and this resumes it into
 * existence for the first time.
 */
export async function answerQuestion(params: {
  db: SupabaseClient<Database>;
  aiClient: AiClient;
  questionId: string;
  answer: string;
}): Promise<AnswerQuestionOutcome> {
  const { db, aiClient, questionId, answer } = params;

  const { data: question, error } = await db
    .from("agent_questions")
    .select("*")
    .eq("id", questionId)
    .single();
  if (error || !question) {
    return { ok: false, message: "Question not found." };
  }
  if (question.status === "answered") {
    return { ok: false, message: "Question was already answered." };
  }

  const { error: updateError } = await db
    .from("agent_questions")
    .update({ status: "answered", answer, answered_at: new Date().toISOString() })
    .eq("id", questionId);
  if (updateError) {
    return { ok: false, message: updateError.message };
  }

  if (!question.context_draft_id) {
    return { ok: true };
  }

  const { data: draft } = await db
    .from("content_drafts")
    .select("*")
    .eq("id", question.context_draft_id)
    .single();

  if (!draft || draft.blocked_on_question_id !== questionId) {
    return { ok: true };
  }

  const resumed = await regenerateDraftContent({
    db,
    aiClient,
    draft,
    factCorrection: `Alex answered the blocking question.\nQ: ${question.question}\nA: ${answer}\nUse this as authoritative fact.`,
  });

  return { ok: true, resumed };
}
