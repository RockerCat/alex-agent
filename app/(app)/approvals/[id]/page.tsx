import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DraftActions } from "@/components/DraftActions";
import { AssetPanel } from "@/components/AssetPanel";
import { listAssets } from "@/lib/agent/assetGenerator";
import { SupabaseAssetStorage } from "@/lib/agent/assetStorage";
import { getPublication } from "@/lib/agent/publish";

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

  const assetEligible = draft.status === "approved" && draft.content_type === "image_post";
  const assets = assetEligible ? await listAssets(db, draft.id) : [];
  const latestAsset = assets[0] ?? null;
  const previewUrl =
    latestAsset?.storage_path
      ? await new SupabaseAssetStorage(db).createSignedUrl(latestAsset.storage_path, 3600)
      : null;
  // draft.channel is "facebook" | "instagram" — the exact same union as
  // PublicationChannel, so the draft's own channel is always the right
  // slot to read (getPublication still defaults to "facebook" for any
  // other caller that predates this).
  const publication = latestAsset ? await getPublication(db, latestAsset.id, draft.channel) : null;

  // Instagram carousel v1: read-only in the dashboard (generation, review,
  // approval and publication all run through the email lifecycle). Never
  // routed through the single-image AssetPanel.
  const isCarousel = draft.status === "approved" && draft.content_type === "carousel";
  const carouselAssets = isCarousel ? await listAssets(db, draft.id) : [];
  const latestCarousel = carouselAssets[0] ?? null;
  const carouselStorage = new SupabaseAssetStorage(db);
  const carouselSlideUrls = latestCarousel
    ? await Promise.all((latestCarousel.slides ?? []).map((slide) => carouselStorage.createSignedUrl(slide.storage_path, 3600)))
    : [];
  const carouselPublication = latestCarousel ? await getPublication(db, latestCarousel.id, draft.channel) : null;

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

      {assetEligible && (
        <Card>
          <h2 className="font-medium mb-3">Asset (image post)</h2>
          <AssetPanel
            draftId={draft.id}
            draftChannel={draft.channel}
            asset={latestAsset}
            previewUrl={previewUrl}
            history={assets.slice(1)}
            publication={publication}
          />
        </Card>
      )}

      {isCarousel && (
        <Card>
          <h2 className="font-medium mb-1">Carousel</h2>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
            Carousel review, approval and publication run through email. Regenerate and Request Changes are not available for carousels in
            the dashboard yet.
          </p>
          {!latestCarousel ? (
            <p className="text-sm">No carousel images generated yet.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <p>
                v{latestCarousel.asset_version} · {latestCarousel.status.replace(/_/g, " ")} · {(latestCarousel.slides ?? []).length} slides
                {carouselPublication ? ` · Instagram: ${carouselPublication.status}` : ""}
              </p>
              {latestCarousel.error_message && <p style={{ color: "#b91c1c" }}>{latestCarousel.error_message}</p>}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(latestCarousel.slides ?? []).map((slide, i) => (
                  <figure key={slide.position}>
                    {carouselSlideUrls[i] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={carouselSlideUrls[i]!} alt={`Slide ${slide.position}`} className="w-full rounded border" style={{ borderColor: "var(--border)" }} />
                    ) : (
                      <div className="text-xs" style={{ color: "var(--muted)" }}>
                        Preview unavailable
                      </div>
                    )}
                    <figcaption className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                      {slide.position}/{(latestCarousel.slides ?? []).length}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

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
