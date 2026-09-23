import { supabaseAdmin } from "@/lib/supabase/admin";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { emailActionJson, readTokenFromRequest } from "@/lib/agent/emailActionHttp";

// Public, POST-only: the explicit, user-confirmed decision. Delegates to
// confirmEmailAction(), which calls the existing authoritative
// approveDraft/rejectDraft/approveAsset with the token's exact version and
// consumes the token exactly once. There is deliberately no GET handler —
// navigation alone can never decide anything.

export async function POST(request: Request) {
  const token = await readTokenFromRequest(request);
  if (token === null) return emailActionJson({ result: "invalid" }, 400);
  try {
    return emailActionJson(await confirmEmailAction(supabaseAdmin(), token));
  } catch {
    return emailActionJson({ result: "error" }, 500);
  }
}
