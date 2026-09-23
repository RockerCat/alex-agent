import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { emailActionJson, readTokenFromRequest } from "@/lib/agent/emailActionHttp";
import { runContinuationSafely } from "@/lib/agent/postApprovalContinuation";

// Public, POST-only: the explicit, user-confirmed decision. Delegates to
// confirmEmailAction(), which calls the existing authoritative
// approveDraft/rejectDraft/approveAsset with the token's exact version and
// consumes the token exactly once. There is deliberately no GET handler —
// navigation alone can never decide anything.
//
// When an approve_draft is applied, the post-approval continuation
// (first asset → finished-publication review email; see
// lib/agent/postApprovalContinuation.ts) is scheduled with Next's after(),
// so this response never waits on image generation or email delivery, and
// a continuation failure can never undo the already-applied approval (the
// cron catch-up sweep retries it). approve_asset / reject_draft schedule
// nothing — in particular, nothing here publishes.

export async function POST(request: Request) {
  const token = await readTokenFromRequest(request);
  if (token === null) return emailActionJson({ result: "invalid" }, 400);
  try {
    const result = await confirmEmailAction(supabaseAdmin(), token, undefined, {
      onApplied: (applied) => {
        if (applied.action === "approve_draft") {
          after(() => runContinuationSafely(applied.subjectId));
        }
      },
    });
    return emailActionJson(result);
  } catch {
    return emailActionJson({ result: "error" }, 500);
  }
}
