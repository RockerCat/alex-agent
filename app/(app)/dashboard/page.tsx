import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadDashboardData } from "@/lib/agent/dashboardData";
import { runMarketingCycleAction } from "@/app/actions";
import { RunCycleButton } from "@/components/RunCycleButton";
import { StatusBadge } from "@/components/StatusBadge";
import { BudgetBar } from "@/components/BudgetBar";

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      {children}
    </div>
  );
}

export default async function DashboardPage() {
  const data = await loadDashboardData(supabaseAdmin());

  const isRunning = data.status === "running";
  const isDisabled = data.status === "disabled";
  const isBudgetPaused = data.status === "budget_paused";
  const runDisabled = isRunning || isDisabled || isBudgetPaused;
  const disabledReason = isRunning
    ? "A marketing cycle is already running."
    : isDisabled
      ? "SolarDesk is disabled in Settings."
      : isBudgetPaused
        ? "Monthly AI budget is exhausted."
        : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">SolarDesk</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            AlexAgent&rsquo;s autonomous marketing manager for SolarDesk.
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-medium">Marketing cycle</h2>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Wakes AlexAgent up to inspect SolarDesk&rsquo;s state and decide what, if anything, should happen next.
            </p>
          </div>
          <RunCycleButton action={runMarketingCycleAction} disabled={runDisabled} disabledReason={disabledReason} />
        </div>
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Current cycle</h2>
        {data.activePlan ? (
          <div className="space-y-1 text-sm">
            <p>
              <span style={{ color: "var(--muted)" }}>Objective:</span>{" "}
              <span className="font-medium">{data.activePlan.primaryObjective}</span>
            </p>
            <p style={{ color: "var(--muted)" }}>{data.activePlan.strategySummary}</p>
            <p style={{ color: "var(--muted)" }}>
              Period: {data.activePlan.periodStart} → {data.activePlan.periodEnd}
            </p>
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No active marketing plan. Run the marketing cycle to let AlexAgent decide what&rsquo;s next.
          </p>
        )}
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Needs your attention</h2>
        <div className="flex flex-col gap-2 text-sm">
          <Link href="/approvals" className="flex items-center justify-between rounded-md border px-3 py-2" style={{ borderColor: "var(--border)" }}>
            <span>Drafts pending approval</span>
            <span className="font-semibold">{data.pendingDraftsCount}</span>
          </Link>
          <Link href="/questions" className="flex items-center justify-between rounded-md border px-3 py-2" style={{ borderColor: "var(--border)" }}>
            <span>Open questions</span>
            <span className="font-semibold">{data.openQuestionsCount}</span>
          </Link>
        </div>
      </Card>

      <Card>
        <BudgetBar budget={data.budget} />
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Recent activity</h2>
        {data.recentRuns.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No runs yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.recentRuns.map((run) => (
              <li key={run.id} className="border-b pb-2 last:border-0 last:pb-0" style={{ borderColor: "var(--border)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {run.decision ?? run.status.toUpperCase()}
                  </span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                {run.summary && <p style={{ color: "var(--muted)" }}>{run.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
