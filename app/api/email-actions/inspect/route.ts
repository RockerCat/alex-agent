import { supabaseAdmin } from "@/lib/supabase/admin";
import { inspectEmailAction } from "@/lib/agent/emailActions";
import { emailActionJson, readTokenFromRequest } from "@/lib/agent/emailActionHttp";

// Public, READ-ONLY: describes what an email action token would do. Never
// consumes the token and never mutates workflow state, so link scanners
// that execute page scripts still cannot cause a decision. Authorization
// is possession of the high-entropy, expiring token (see
// lib/agent/emailActions.ts); proxy.ts exempts this exact path from the
// session gate.

export async function POST(request: Request) {
  const token = await readTokenFromRequest(request);
  if (token === null) return emailActionJson({ state: "invalid" }, 400);
  try {
    return emailActionJson(await inspectEmailAction(supabaseAdmin(), token));
  } catch {
    // Never echo error details (or the token) back.
    return emailActionJson({ state: "error" }, 500);
  }
}
