import type { BudgetSnapshot } from "@/lib/agent/budgetGuard";

const LEVEL_COLOR: Record<BudgetSnapshot["thresholdLevel"], string> = {
  ok: "#16a34a",
  informational: "#2563eb",
  warning: "#d97706",
  critical: "#ea580c",
  blocked: "#dc2626",
};

export function BudgetBar({ budget }: { budget: BudgetSnapshot }) {
  const pct = Math.min(100, Math.max(0, budget.monthlyUsagePct));
  const color = LEVEL_COLOR[budget.thresholdLevel];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span style={{ color: "var(--muted)" }}>Monthly AI budget</span>
        <span className="font-medium">
          ${budget.monthlySpentUsd.toFixed(2)} / ${budget.monthlyBudgetUsd.toFixed(2)}
        </span>
      </div>
      <div className="h-2 w-full rounded-full" style={{ background: "var(--border)" }}>
        <div
          className="h-2 rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Effective stop at ${budget.effectiveStopUsd.toFixed(2)} (safety reserve $
        {budget.safetyReserveUsd.toFixed(2)}) · per-run limit ${budget.perRunBudgetUsd.toFixed(2)}
      </p>
    </div>
  );
}
