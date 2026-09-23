import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { emailActionJson, readTokenFromRequest } from "@/lib/agent/emailActionHttp";
import { runContinuationSafely } from "@/lib/agent/postApprovalContinuation";
import { runAutoPublicationSafely } from "@/lib/agent/postApprovalPublication";

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
// cron catch-up sweep retries it).
//
// When an approve_asset ("Aprobar publicación" — the FINAL human
// authorization) is applied, automatic publication of that exact asset to
// its draft's exact channel is scheduled the same way (see
// lib/agent/postApprovalPublication.ts): the response never waits on
// Meta, and a publication failure never revokes the approval (the cron
// recovery sweep retries only provably-safe failures). reject_draft, and
// any non-applied confirmation, schedule nothing.

export async function POST(request: Request) {
  const token = await readTokenFromRequest(request);
  if (token === null) return emailActionJson({ result: "invalid" }, 400);
  try {
    const result = await confirmEmailAction(supabaseAdmin(), token, undefined, {
      onApplied: (applied) => {
        if (applied.action === "approve_draft") {
          after(() => runContinuationSafely(applied.subjectId));
        } else if (applied.action === "approve_asset") {
          after(() => runAutoPublicationSafely(applied.subjectId));
        }
      },
    });
    return emailActionJson(result);
  } catch {
    return emailActionJson({ result: "error" }, 500);
  }
}
