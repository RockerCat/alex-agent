"use client";

import { useEffect, useState } from "react";
import { getBrandSpendSummaryAction } from "@/app/actions";

// "Today" and "Daily avg." AI spend, computed against the visitor's
// real browser-local calendar day/month — never the server/Vercel
// runtime's timezone (same principle as components/LocalDateTime.tsx).
// The existing "Monthly AI budget" figure above intentionally keeps its
// own UTC-month definition (matching Budget Guard's enforcement
// window); these are separate, local-calendar-day metrics, so their
// boundaries must be computed in the browser and cannot be derived by
// the Server Component that renders the rest of the Dashboard.
//
// No raw usage rows ever reach the browser: only the two already-summed
// dollar totals returned by the server action. Both boundaries are
// computed once, on mount, from the actual browser clock — never
// hardcoded to any specific timezone.

interface SpendSummary {
  todayUsd: number;
  monthToDateUsd: number;
  elapsedLocalDays: number;
}

export interface LocalSpendBoundaries {
  todayStartIso: string;
  monthStartIso: string;
  elapsedLocalDays: number;
}

/**
 * Extracted so this exact boundary math is directly unit-testable
 * (across a timezone/date boundary) without needing a DOM/React
 * rendering test setup this repository doesn't otherwise have — same
 * pattern as components/LocalDateTime.tsx's formatLocalDateTime.
 *
 * Constructing a Date from local y/m/d components and reading it back
 * as an ISO (UTC) instant is exactly "local midnight, as an absolute
 * instant" — correct for any runtime timezone, no offset arithmetic
 * needed. getDate() (1–31) is already exactly "elapsed local calendar
 * days this month, including today" — 1 on the first day of the month,
 * never 0.
 */
export function computeLocalSpendBoundaries(now: Date): LocalSpendBoundaries {
  return {
    todayStartIso: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    monthStartIso: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    elapsedLocalDays: now.getDate(),
  };
}

export function DailySpend({ brand }: { brand: string }) {
  const [summary, setSummary] = useState<SpendSummary | null>(null);

  useEffect(() => {
    const { todayStartIso, monthStartIso, elapsedLocalDays } = computeLocalSpendBoundaries(new Date());

    let cancelled = false;
    getBrandSpendSummaryAction({ brand, todayStartIso, monthStartIso }).then((result) => {
      if (cancelled || "error" in result) return;
      setSummary({ todayUsd: result.todayUsd, monthToDateUsd: result.monthToDateUsd, elapsedLocalDays });
    });
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const todayLabel = summary ? `$${summary.todayUsd.toFixed(2)}` : "…";
  const dailyAvgLabel = summary ? `$${(summary.monthToDateUsd / summary.elapsedLocalDays).toFixed(2)}/day` : "…";

  return (
    <div className="flex items-center justify-between text-xs pt-1.5 mt-1.5 border-t" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
      <span>
        Today <span className="font-medium" style={{ color: "var(--foreground)" }}>{todayLabel}</span>
      </span>
      <span>
        Daily avg. <span className="font-medium" style={{ color: "var(--foreground)" }}>{dailyAvgLabel}</span>
      </span>
    </div>
  );
}
