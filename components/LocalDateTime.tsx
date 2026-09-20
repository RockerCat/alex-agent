"use client";

/**
 * Renders an ISO timestamp in the viewer's actual browser timezone.
 * DashboardPage is a Server Component, so calling toLocaleString() there
 * runs on the server (Vercel's runtime timezone, effectively UTC) —
 * never the visitor's real timezone. This must be a Client Component so
 * the formatting genuinely executes in the browser.
 *
 * suppressHydrationWarning is intentional and safe here: the underlying
 * instant is identical between server and client, only this text node's
 * *formatted* content can legitimately differ by timezone. React
 * reconciles a mismatched text node's content during hydration rather
 * than discarding the tree, so the browser-local value always wins.
 */
// Extracted so the exact formatting logic the component renders is
// directly unit-testable (across a timezone/date boundary) without
// needing a DOM/React-rendering test setup this repository doesn't
// otherwise have.
export function formatLocalDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function LocalDateTime({ iso }: { iso: string }) {
  return <span suppressHydrationWarning>{formatLocalDateTime(iso)}</span>;
}
