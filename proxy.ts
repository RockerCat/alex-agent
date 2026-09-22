import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// /privacy and /data-deletion are Meta's required public URLs for app
// review (see app/privacy/page.tsx, app/data-deletion/page.tsx) — real
// pages a human/reviewer loads in a browser, so they belong in
// PUBLIC_PATHS (a plain login-redirect exemption) rather than
// API_AUTH_EXEMPT_PREFIXES below, which is specifically for
// machine-to-machine routes with their own non-session authentication.
//
// Matched below via exact-path-or-subpath ("p" itself, or "p/...") —
// NOT plain startsWith — specifically so that e.g. a hypothetical
// future "/data-deletion-test" route is never accidentally exempted by
// sharing a text prefix with "/data-deletion". This does not change
// matching for any currently existing route: none of today's real
// routes share a prefix stem with an entry here without a "/" boundary.
const PUBLIC_PATHS = ["/login", "/auth/callback", "/privacy", "/data-deletion"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Machine-to-machine routes with their own non-session authentication
// (a shared secret header, checked inside the Route Handler itself — see
// app/api/cron/marketing-cycle/route.ts). These callers have no browser
// session/cookie, so the session-based gate below must not apply to
// them; redirecting a scheduler's POST to /login would make the
// endpoint unreachable rather than making it more secure.
//
// /api/webhooks/whatsapp is the same shape: Meta calls it with no
// AlexAgent session, and it already validates its own caller via
// META_WHATSAPP_WEBHOOK_VERIFY_TOKEN on GET (see
// lib/agent/whatsappWebhook.ts) — this exemption only lets the request
// reach that check instead of being redirected to /login before it
// gets there. Deliberately the exact route, not a broader "/api/webhooks/"
// prefix, so no future unrelated webhook route is exempted by accident.
const API_AUTH_EXEMPT_PREFIXES = ["/api/cron/", "/api/webhooks/whatsapp"];

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (API_AUTH_EXEMPT_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p))) {
    return response;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    // Misconfigured deployment — fail closed rather than silently allowing
    // an unauthenticated user into a private operational app.
    return new NextResponse("AlexAgent is not configured.", { status: 500 });
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const isPublic = isPublicPath(request.nextUrl.pathname);

  const ownerEmail = process.env.OWNER_EMAIL;
  const authorized = Boolean(data.user) && (!ownerEmail || data.user?.email === ownerEmail);

  if (!authorized && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (authorized && request.nextUrl.pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
