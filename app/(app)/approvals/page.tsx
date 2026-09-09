import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const db = supabaseAdmin();
  const { data: drafts } = await db
    .from("content_drafts")
    .select("*")
    .eq("brand", "solardesk")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Drafts AlexAgent prepared for SolarDesk, awaiting your review.
        </p>
      </div>

      {(!drafts || drafts.length === 0) && (
        <div className="rounded-lg border p-6 text-sm text-center" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          Nothing waiting for review right now.
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
