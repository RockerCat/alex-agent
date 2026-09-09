import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DraftActions } from "@/components/DraftActions";

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      {children}
    </div>
  );
}

export default async function DraftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: draft } = await db.from("content_drafts").select("*").eq("id", id).single();
  if (!draft) notFound();

  const { data: revisions } = await db
    .from("content_revisions")
    .select("*")
    .eq("draft_id", id)
    .order("version", { ascending: false });

  const { data: blockingQuestion } = draft.blocked_on_question_id
    ? await db.from("agent_questions").select("*").eq("id", draft.blocked_on_question_id).single()
    : { data: null };

  const slides = (draft.body as { slides?: { slide: number; text: string }[] })?.slides ?? [];

  return (
    <div className="space-y-4">
      <Link href="/approvals" className="text-sm" style={{ color: "var(--muted)" }}>
        ← Back to Approvals
      </Link>

      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{draft.title ?? draft.topic}</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            SolarDesk · {draft.channel} · {draft.content_type} · v{draft.version}
          </p>
        </div>
        <span
          className="text-xs rounded-full px-2.5 py-1 font-semibold"
          style={{ background: "var(--border)" }}
        >
          {draft.status.replace(/_/g, " ")}
        </span>
      </div>

      {draft.status === "revision_requested" && blockingQuestion && (
        <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "#f59e0b", background: "#fffbeb" }}>
          Blocked — AlexAgent needs a business answer before it can safely revise this draft.{" "}
          <Link href="/questions" className="font-semibold underline">
            Answer in Questions →
          </Link>
        </div>
      )}

      <Card>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt style={{ color: "var(--muted)" }}>Purpose</dt>
            <dd>{draft.purpose}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>Audience</dt>
            <dd>{draft.audience}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>Target date</dt>
            <dd>{draft.target_date}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>CTA</dt>
            <dd>{draft.cta_text ?? draft.cta}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="font-medium mb-2">Content</h2>
        <div className="space-y-3 text-sm">
          {draft.hook && (
            <p>
              <span className="font-medium">Hook:</span> {draft.hook}
            </p>
          )}
          {slides.length > 0 && (
            <div>
              <span className="font-medium">Slides:</span>
              <ol className="list-decimal ml-5 mt-1 space-y-1">
                {slides.map((s) => (
                  <li key={s.slide}>{s.text}</li>
                ))}
              </ol>
            </div>
          )}
          {draft.caption && (
            <p>
              <span className="font-medium">Caption:</span> {draft.caption}
            </p>
          )}
          {draft.visual_direction && (
            <p>
              <span className="font-medium">Visual direction:</span> {draft.visual_direction}
            </p>
          )}
          {draft.hashtags?.length > 0 && (
            <p style={{ color: "var(--muted)" }}>{draft.hashtags.join(" ")}</p>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="font-medium mb-3">Review</h2>
        <DraftActions draftId={draft.id} canAct={draft.status === "pending_approval"} />
      </Card>

      {revisions && revisions.length > 1 && (
        <Card>
          <h2 className="font-medium mb-3">Revision history</h2>
          <ul className="space-y-3 text-sm">
            {revisions.map((rev) => (
              <li key={rev.id} className="border-b pb-2 last:border-0 last:pb-0" style={{ borderColor: "var(--border)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">v{rev.version}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {rev.source === "initial" ? "initial" : rev.feedback_category ?? "revision"}
                  </span>
                </div>
                {rev.feedback_note && <p style={{ color: "var(--muted)" }}>{rev.feedback_note}</p>}
                <p className="mt-1">{rev.hook}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
