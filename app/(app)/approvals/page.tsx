import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listDraftsForTab, type ApprovalsTab } from "@/lib/agent/approvalsListing";

export const dynamic = "force-dynamic";

const EMPTY_MESSAGE: Record<ApprovalsTab, string> = {
  pending: "Nothing waiting for review right now.",
  approved: "No approved content yet.",
};

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab: ApprovalsTab = tab === "approved" ? "approved" : "pending";

  const drafts = await listDraftsForTab(supabaseAdmin(), activeTab);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Drafts AlexAgent prepared for SolarDesk.
        </p>
      </div>

      <div className="flex gap-1 border-b" style={{ borderColor: "var(--border)" }}>
        {(["pending", "approved"] as const).map((t) => (
          <Link
            key={t}
            href={t === "pending" ? "/approvals" : "/approvals?tab=approved"}
            className="px-3 py-2 text-sm font-medium"
            style={
              activeTab === t
                ? { borderBottom: "2px solid var(--accent)", color: "var(--foreground)" }
                : { color: "var(--muted)" }
            }
          >
            {t === "pending" ? "Pending" : "Approved"}
          </Link>
        ))}
      </div>

      {(!drafts || drafts.length === 0) && (
        <div className="rounded-lg border p-6 text-sm text-center" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          {EMPTY_MESSAGE[activeTab]}
        </div>
      )}

      <ul className="space-y-2">
        {drafts?.map((draft) => (
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
    </div>
  );
}
