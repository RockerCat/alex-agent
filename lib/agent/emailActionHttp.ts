import { NextResponse } from "next/server";

// Shared request/response handling for the public email-action endpoints
// (app/api/email-actions/*). The one-time token arrives only in a small
// JSON POST body — never in a URL — and is never logged here.

const MAX_BODY_BYTES = 1024;

export const EMAIL_ACTION_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function emailActionJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: EMAIL_ACTION_RESPONSE_HEADERS });
}

/** Returns the raw token field (unvalidated — the domain layer validates its format), or null for any malformed/oversized body. */
export async function readTokenFromRequest(request: Request): Promise<string | null> {
  const raw = await request.text();
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed?.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}
