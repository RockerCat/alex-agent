import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listApprovalsGroupedByCycle, type ApprovalsCycleGroup, type ApprovalsTab } from "@/lib/agent/approvalsListing";

export const dynamic = "force-dynamic";

const EMPTY_MESSAGE: Record<ApprovalsTab, string> = {
  pending: "Nothing waiting for review right now.",
  approved: "No approved content yet.",
  rejected: "No rejected content.",
};

const TAB_LABEL: Record<ApprovalsTab, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

function parseTab(tab: string | undefined): ApprovalsTab {
  if (tab === "approved" || tab === "rejected") return tab;
  return "pending";
}

/** "2026-09-17" / "2026-09-24" -> "Sep 17–24, 2026" (or "Sep 30 – Oct 3, 2026" across months/years). */
function formatCyclePeriod(startIso: string, endIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const sameMonthYear = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();

  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const endLabel = end.toLocaleDateString(
    "en-US",
    sameMonthYear ? { day: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }
  );
  return `${startLabel}–${endLabel}, ${end.getUTCFullYear()}`;
}

function CycleHeader({ group }: { group: ApprovalsCycleGroup }) {
  if (!group.plan) {
    return (
      <div>
        <h2 className="font-medium">Unknown / legacy cycle</h2>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          These drafts&rsquo; original marketing plan record is no longer available.
        </p>
      </div>
    );
  }

  const { plan } = group;
  return (
    <div>
      <h2 className="font-medium">
        {plan.primary_objective} · {formatCyclePeriod(plan.period_start, plan.period_end)}
      </h2>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {plan.status}
        {group.isCurrentCycle ? " / Current cycle" : ""}
      </p>
    </div>
  );
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = parseTab(tab);

  const groups = await listApprovalsGroupedByCycle(supabaseAdmin(), activeTab);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Drafts AlexAgent prepared for SolarDesk.
        </p>
      </div>

      <div className="flex gap-1 border-b" style={{ borderColor: "var(--border)" }}>
        {(["pending", "approved", "rejected"] as const).map((t) => (
          <Link
            key={t}
            href={t === "pending" ? "/approvals" : `/approvals?tab=${t}`}
            className="px-3 py-2 text-sm font-medium"
            style={
              activeTab === t
                ? { borderBottom: "2px solid var(--accent)", color: "var(--foreground)" }
                : { color: "var(--muted)" }
            }
          >
            {TAB_LABEL[t]}
          </Link>
        ))}
      </div>

      {groups.length === 0 && (
        <div className="rounded-lg border p-6 text-sm text-center" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          {EMPTY_MESSAGE[activeTab]}
        </div>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <details key={group.plan?.id ?? "unknown"} className="group space-y-2" open={group.isCurrentCycle}>
            <summary className="flex items-start gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <span
                className="mt-1 inline-block transition-transform duration-150 group-open:rotate-90"
                style={{ color: "var(--muted)" }}
                aria-hidden="true"
              >
                ▸
              </span>
              <CycleHeader group={group} />
            </summary>
            <ul className="space-y-2 mt-2">
              {group.drafts.map((draft) => (
                <li key={draft.id}>
                  <Link
                    href={`/approvals/${draft.id}`}
                    className="block rounded-lg border p-4 hover:opacity-90"
                    style={{ borderColor: "var(--border)", background: "var(--card)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{draft.title ?? draft.topic}</span>
                      <span className="text-xs rounded px-2 py-0.5" style={{ background: "var(--border)" }}>
                        {draft.channel} · {draft.content_type}
                      </span>
                    </div>
                    <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
                      {draft.topic} · target {draft.target_date} · v{draft.version}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
