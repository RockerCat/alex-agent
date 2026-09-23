import type { ContentAssetRow, ContentDraftRow, ContentRevisionRow } from "@/lib/types/database";
import type { EmailInlineAttachment } from "@/lib/agent/emailClient";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";

// Provider-neutral review email rendering (Email HITL, Phase 2A).
//
// Pure functions over the EXISTING durable records (content_drafts,
// marketing_plans.primary_objective, content_revisions, content_assets) —
// never invents copy, never calls a model. Every draft/asset/revision
// value is model- or human-generated and is HTML-escaped before it
// reaches the HTML body; the plain-text alternative carries the same
// information.
//
// Deliberately NOT functional yet: there are no approve/reject links, no
// action tokens, and no AlexAgent URLs anywhere in these emails. The
// "decision" section is a clearly non-functional placeholder, and the
// only URL that can appear is the draft's own CTA destination, rendered
// as plain text (never an <a href>).
//
// Asset images are embedded inline via CID (bytes read through
// AssetStorage.download()), so the private bucket stays private and no
// expiring signed URL is ever put in an email body.

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderedEmailWithAttachments extends RenderedEmail {
  inlineAttachments: EmailInlineAttachment[];
}

export interface ContentReviewEmailInput {
  brandDisplayName: string;
  draft: ContentDraftRow;
  /** marketing_plans.primary_objective of the draft's plan, when available. */
  planObjective?: string | null;
  /** The content_revisions row for draft.version, when it carries feedback (i.e. this version answers a "Request Changes"). */
  latestRevision?: ContentRevisionRow | null;
}

export interface AssetReviewEmailInput {
  brandDisplayName: string;
  draft: ContentDraftRow;
  asset: ContentAssetRow;
  planObjective?: string | null;
  /** From loadAssetInlineImage(); null renders a "no image available" notice instead of an image. */
  image: EmailInlineAttachment | null;
}

const MAX_SUBJECT_LENGTH = 150;

const CHANNEL_LABELS: Record<ContentDraftRow["channel"], string> = {
  instagram: "Instagram",
  facebook: "Facebook",
};

const CONTENT_TYPE_LABELS: Record<ContentDraftRow["content_type"], string> = {
  image_post: "Imagen (image_post)",
  carousel: "Carrusel",
  story: "Story",
  caption_only: "Solo texto (caption_only)",
};

const FEEDBACK_CATEGORY_LABELS: Record<NonNullable<ContentRevisionRow["feedback_category"]>, string> = {
  too_generic: "Demasiado genérico",
  too_promotional: "Demasiado promocional",
  too_long: "Demasiado largo",
  too_technical: "Demasiado técnico",
  wrong_tone: "Tono incorrecto",
  weak_hook: "Hook débil",
  weak_cta: "CTA débil",
  factually_incorrect: "Dato incorrecto",
  visual_needs_work: "Visual por mejorar",
  other: "Otro",
};

const PENDING_ACTIONS_NOTICE =
  "Aprobar, rechazar o pedir cambios desde este correo estará disponible próximamente. Por ahora este correo es solo informativo.";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Header-safe: single line (no CR/LF header injection), collapsed whitespace, bounded length. */
function sanitizeSubject(value: string): string {
  const oneLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return oneLine.length > MAX_SUBJECT_LENGTH ? `${oneLine.slice(0, MAX_SUBJECT_LENGTH - 3)}...` : oneLine;
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function slidesOf(draft: ContentDraftRow): { slide: number; text: string }[] {
  const slides = draft.body?.slides;
  return Array.isArray(slides) ? [...slides].sort((a, b) => a.slide - b.slide) : [];
}

// ---------------------------------------------------------------------
// Shared building blocks: each section yields both an HTML fragment and
// its plain-text counterpart, so the two alternatives never drift apart.
// ---------------------------------------------------------------------

interface Section {
  html: string;
  text: string;
}

function field(label: string, value: string | null | undefined): Section | null {
  if (!nonEmpty(value)) return null;
  return {
    html: `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
    text: `${label}: ${value}`,
  };
}

function fieldTable(title: string, rows: (Section | null)[]): Section {
  const present = rows.filter((r): r is Section => r !== null);
  return {
    html: `<h2 style="font-size:16px;margin:24px 0 8px">${escapeHtml(title)}</h2><table style="border-collapse:collapse;font-size:14px">${present.map((r) => r.html).join("")}</table>`,
    text: `== ${title} ==\n${present.map((r) => r.text).join("\n")}`,
  };
}

function block(title: string, value: string | null | undefined): Section | null {
  if (!nonEmpty(value)) return null;
  return {
    html: `<h3 style="font-size:14px;margin:16px 0 4px">${escapeHtml(title)}</h3><div style="font-size:14px;white-space:pre-wrap">${escapeHtml(value)}</div>`,
    text: `-- ${title} --\n${value}`,
  };
}

function slidesSection(draft: ContentDraftRow): Section | null {
  const slides = slidesOf(draft);
  if (slides.length === 0) return null;
  const heading = draft.content_type === "carousel" ? "Textos de las diapositivas" : "Texto de la pieza";
  return {
    html: `<h3 style="font-size:14px;margin:16px 0 4px">${escapeHtml(heading)}</h3><ol style="font-size:14px;padding-left:20px;margin:0">${slides
      .map((s) => `<li style="margin:4px 0;white-space:pre-wrap">${escapeHtml(s.text)}</li>`)
      .join("")}</ol>`,
    text: `-- ${heading} --\n${slides.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}`,
  };
}

function hashtagsSection(draft: ContentDraftRow): Section | null {
  const tags = (draft.hashtags ?? []).filter(nonEmpty);
  if (tags.length === 0) return null;
  const joined = tags.join(" ");
  return {
    html: `<h3 style="font-size:14px;margin:16px 0 4px">Hashtags</h3><div style="font-size:14px;color:#555">${escapeHtml(joined)}</div>`,
    text: `-- Hashtags --\n${joined}`,
  };
}

/** CTA label plus destination; the URL is shown as literal text in <code>, never an anchor. */
function ctaSection(draft: ContentDraftRow): Section | null {
  const { label, url } = resolveCtaLabelAndUrl(draft);
  const effectiveLabel = nonEmpty(label) ? label : draft.cta;
  if (!nonEmpty(effectiveLabel) && !url) return null;

  const labelRow = field("Texto del CTA", effectiveLabel);
  const urlRow: Section | null = url
    ? {
        html: `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;white-space:nowrap">Destino del CTA</td><td style="padding:4px 0"><code style="font-size:13px;background:#f3f3f3;padding:1px 4px">${escapeHtml(url)}</code> <span style="color:#777;font-size:12px">(solo referencia, sin enlace)</span></td></tr>`,
        text: `Destino del CTA (solo referencia): ${url}`,
      }
    : null;
  const rows = [labelRow, urlRow].filter((r): r is Section => r !== null);
  return {
    html: `<h3 style="font-size:14px;margin:16px 0 4px">Llamado a la acción</h3><table style="border-collapse:collapse;font-size:14px">${rows.map((r) => r.html).join("")}</table>`,
    text: `-- Llamado a la acción --\n${rows.map((r) => r.text).join("\n")}`,
  };
}

function revisionFeedbackSection(draft: ContentDraftRow, revision: ContentRevisionRow | null | undefined): Section | null {
  if (!revision || revision.version !== draft.version) return null;
  if (!revision.feedback_category && !nonEmpty(revision.feedback_note)) return null;
  const category = revision.feedback_category ? FEEDBACK_CATEGORY_LABELS[revision.feedback_category] : null;
  return fieldTable(`Cambios solicitados que originaron la versión ${draft.version}`, [
    field("Categoría", category),
    field("Nota", revision.feedback_note),
  ]);
}

function pendingActionsSection(): Section {
  return {
    html: `<div style="margin:28px 0 8px;padding:12px;border:1px dashed #bbb;border-radius:6px;font-size:13px;color:#555">${escapeHtml(PENDING_ACTIONS_NOTICE)}</div>`,
    text: `-- Decisión --\n${PENDING_ACTIONS_NOTICE}`,
  };
}

function contextSection(input: { brandDisplayName: string; draft: ContentDraftRow; planObjective?: string | null }, extra: (Section | null)[] = []): Section {
  const { brandDisplayName, draft, planObjective } = input;
  return fieldTable("Contexto", [
    field("Marca", brandDisplayName),
    field("Canal", CHANNEL_LABELS[draft.channel] ?? draft.channel),
    field("Formato", CONTENT_TYPE_LABELS[draft.content_type] ?? draft.content_type),
    field("Versión del contenido", `v${draft.version}`),
    ...extra,
    field("Fecha objetivo", draft.target_date),
    field("Objetivo del plan", planObjective ?? null),
    field("Propósito", draft.purpose),
    field("Tema", draft.topic),
    field("Audiencia", draft.audience),
  ]);
}

function wrapDocument(title: string, intro: string, sections: (Section | null)[]): { html: string; text: string } {
  const present = sections.filter((s): s is Section => s !== null);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title
  )}</title></head><body style="margin:0;padding:16px;background:#ffffff;color:#111;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45"><div style="max-width:640px;margin:0 auto"><h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(
    title
  )}</h1><p style="font-size:14px;color:#444;margin:0 0 8px">${escapeHtml(intro)}</p>${present.map((s) => s.html).join("")}</div></body></html>`;
  const text = [title, "", intro, "", ...present.map((s) => `${s.text}\n`)].join("\n").trimEnd() + "\n";
  return { html, text };
}

function displayTitle(draft: ContentDraftRow): string {
  return nonEmpty(draft.title) ? draft.title : draft.topic;
}

// ---------------------------------------------------------------------
// Content review email (stage 1: text content pending approval)
// ---------------------------------------------------------------------

export function renderContentReviewEmail(input: ContentReviewEmailInput): RenderedEmail {
  const { brandDisplayName, draft } = input;
  const title = `Revisión de contenido v${draft.version} — ${brandDisplayName}`;
  const intro = `AlexAgent preparó una pieza para ${CHANNEL_LABELS[draft.channel] ?? draft.channel} que está pendiente de tu revisión.`;

  const { html, text } = wrapDocument(title, intro, [
    contextSection(input),
    revisionFeedbackSection(draft, input.latestRevision),
    {
      html: `<h2 style="font-size:16px;margin:24px 0 8px">Contenido</h2>`,
      text: "== Contenido ==",
    },
    block("Título", draft.title),
    block("Hook", draft.hook),
    slidesSection(draft),
    block("Caption", draft.caption),
    hashtagsSection(draft),
    ctaSection(draft),
    block("Dirección visual", draft.visual_direction),
    pendingActionsSection(),
  ]);

  return {
    subject: sanitizeSubject(`[${brandDisplayName}] Revisión de contenido v${draft.version}: ${displayTitle(draft)}`),
    html,
    text,
  };
}

// ---------------------------------------------------------------------
// Asset review email (stage 2: generated image pending review)
// ---------------------------------------------------------------------

function assetImageSection(input: AssetReviewEmailInput): Section {
  const { draft, asset, image } = input;
  if (draft.content_type === "carousel") {
    // Current product capability: carousel slide images are never
    // generated (content_assets.format is image_post only).
    return {
      html: `<p style="font-size:14px;color:#555">Las imágenes de carrusel aún no se generan en AlexAgent; abajo se muestran solo los textos de las diapositivas.</p>`,
      text: "Imagen: las imágenes de carrusel aún no se generan en AlexAgent; se muestran solo los textos de las diapositivas.",
    };
  }
  if (!image) {
    return {
      html: `<p style="font-size:14px;color:#a33">La imagen de esta versión no está disponible para incluirla en el correo.</p>`,
      text: "Imagen: no disponible para incluirla en este correo.",
    };
  }
  const width = asset.width && asset.height ? 540 : null;
  const height = width && asset.width && asset.height ? Math.round((asset.height / asset.width) * width) : null;
  const sizeAttrs = width && height ? ` width="${width}" height="${height}"` : ` width="540"`;
  const alt = `Imagen generada v${asset.asset_version} para: ${displayTitle(draft)}`;
  return {
    html: `<div style="margin:16px 0"><img src="cid:${escapeHtml(image.contentId)}"${sizeAttrs} alt="${escapeHtml(alt)}" style="display:block;max-width:100%;height:auto;border:1px solid #ddd;border-radius:4px"></div>`,
    text: `Imagen: adjunta en línea (${image.filename}). Si tu cliente de correo no muestra imágenes, ábrela como adjunto.`,
  };
}

export function renderAssetReviewEmail(input: AssetReviewEmailInput): RenderedEmailWithAttachments {
  const { brandDisplayName, draft, asset } = input;
  const title = `Revisión de imagen v${asset.asset_version} — ${brandDisplayName}`;
  const intro = `AlexAgent generó la imagen para el contenido aprobado (v${draft.version}). Está pendiente de tu revisión.`;

  const assetFields: (Section | null)[] = [
    field("Versión de la imagen", `v${asset.asset_version}`),
    field("Generada desde el contenido", `v${asset.source_draft_version}`),
  ];
  const versionMismatch: Section | null =
    asset.source_draft_version !== draft.version
      ? {
          html: `<p style="font-size:13px;color:#a33">Atención: esta imagen se generó desde la versión v${asset.source_draft_version} del contenido, pero el contenido actual es v${draft.version}.</p>`,
          text: `ATENCIÓN: esta imagen se generó desde el contenido v${asset.source_draft_version}; el contenido actual es v${draft.version}.`,
        }
      : null;

  const { html, text } = wrapDocument(title, intro, [
    assetImageSection(input),
    versionMismatch,
    contextSection(input, assetFields),
    {
      html: `<h2 style="font-size:16px;margin:24px 0 8px">Texto que acompañará la publicación</h2>`,
      text: "== Texto que acompañará la publicación ==",
    },
    block("Título", draft.title),
    block("Hook", draft.hook),
    slidesSection(draft),
    block("Caption", draft.caption),
    hashtagsSection(draft),
    ctaSection(draft),
    pendingActionsSection(),
  ]);

  const includeImage = draft.content_type !== "carousel" && input.image !== null;
  return {
    subject: sanitizeSubject(`[${brandDisplayName}] Revisión de imagen v${asset.asset_version} (contenido v${draft.version}): ${displayTitle(draft)}`),
    html,
    text,
    inlineAttachments: includeImage && input.image ? [input.image] : [],
  };
}

// ---------------------------------------------------------------------
// Inline image loading (the only I/O in this module)
// ---------------------------------------------------------------------

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

/**
 * Reads the asset's stored image through the existing AssetStorage
 * abstraction (private bucket, no signed URL) and packages it as a CID
 * inline attachment. The contentId/filename are derived from the brand
 * and asset version only — no internal ids. Returns null (never throws)
 * when the asset has no stored file or the download fails, so a caller
 * can still send the review email with a "no image" notice.
 */
export async function loadAssetInlineImage(storage: AssetStorage, asset: ContentAssetRow): Promise<EmailInlineAttachment | null> {
  if (asset.status === "generation_failed" || !asset.storage_path) return null;
  try {
    const content = await storage.download(asset.storage_path);
    const brandSlug = asset.brand.replace(/[^A-Za-z0-9-]/g, "") || "asset";
    return {
      contentId: `${brandSlug}-asset-v${asset.asset_version}`,
      filename: `${brandSlug}-asset-v${asset.asset_version}.${extensionFor(asset.mime_type)}`,
      contentType: asset.mime_type,
      content,
    };
  } catch {
    return null;
  }
}
