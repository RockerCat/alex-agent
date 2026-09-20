"use client";

import { useEffect, useState } from "react";

/**
 * Renders an ISO timestamp in the viewer's actual browser timezone.
 * DashboardPage is a Server Component, so calling toLocaleString() there
 * runs on the server (Vercel's runtime timezone, effectively UTC) —
 * never the visitor's real timezone. This must be a Client Component so
 * the formatting genuinely executes in the browser.
 *
 * Browser-local by construction, not by hydration-mismatch behavior:
 * suppressHydrationWarning does NOT guarantee React replaces a
 * mismatched server-rendered text node with the client-computed value —
 * it only suppresses the dev warning, and can leave the server (UTC)
 * text permanently in the DOM if nothing ever re-renders the component
 * afterward (the real Production bug this replaced). Instead, the
 * initial render (server AND the browser's first hydration pass) is a
 * fixed, timezone-independent placeholder — identical on both sides, so
 * there is no mismatch to reconcile at all. The real local value is
 * only computed in useEffect, which runs exclusively after mount in the
 * real browser, and is written via setState — an ordinary React state
 * update, which unconditionally triggers a genuine post-mount render
 * that writes the browser-local value into the DOM. Same lifecycle
 * principle as components/DailySpend.tsx.
 */
// Extracted so the exact formatting logic the component renders is
// directly unit-testable (across a timezone/date boundary) without
// needing a DOM/React-rendering test setup this repository doesn't
// otherwise have.
export function formatLocalDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function LocalDateTime({ iso }: { iso: string }) {
  const [display, setDisplay] = useState<string | null>(null);

  useEffect(() => {
    // Deliberate exception to the general "avoid setState directly in an
    // effect" guideline: this value can only ever be correct once code
    // is actually running in the visitor's browser (that's the entire
    // point — see the file header), so there is no render-time
    // alternative that wouldn't reintroduce the hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplay(formatLocalDateTime(iso));
  }, [iso]);

  return <span>{display ?? "—"}</span>;
}
