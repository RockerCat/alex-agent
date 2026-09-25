import type { ContentAssetRow, ContentDraftRow, ContentRevisionRow } from "@/lib/types/database";
import type { EmailInlineAttachment } from "@/lib/agent/emailClient";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";

// Provider-neutral review email rendering (Email HITL, Phase 2A).
//
// Pure functions over the EXISTING durable records (content_drafts,
// marketing_plans.primary_objective, content_revisions, content_assets) —
// never invents copy, never calls a model. Every draft/asset/revision
// value is model- or human-generated and is HTML-escaped before it
// reaches the HTML body; the plain-text alternative carries the same
// information.
//
// Decision actions are functional ONLY when the caller supplies action
// URLs (built by application code from opaque one-time tokens — see
// lib/agent/emailActions.ts; never model-generated). Without them the
// decision section is a clearly non-functional placeholder. Apart from
// those action buttons, the only URL that can appear is the draft's own
// CTA destination, rendered as plain text (never an <a href>). "Request
// changes" is never rendered as a button — it arrives with inbound replies.
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
  /** Secure, version-bound action URLs; omitted/null renders the non-functional placeholder. */
  actions?: { approveUrl: string; rejectUrl: string } | null;
}

export interface AssetReviewEmailInput {
  brandDisplayName: string;
  draft: ContentDraftRow;
  asset: ContentAssetRow;
  planObjective?: string | null;
  /** From loadAssetInlineImage(); null renders a "no image available" notice instead of an image. Unused for a carousel asset. */
  image: EmailInlineAttachment | null;
  /** For a carousel asset: every slide image, in the asset's authoritative slide order (loadCarouselInlineImages()). */
  slideImages?: EmailInlineAttachment[] | null;
  /** Secure, version-bound asset approval URL; omitted/null renders the non-functional placeholder. */
  approveAssetUrl?: string | null;
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

const ACTION_SECURITY_NOTE =
  "Cada botón abre una página de confirmación: nada se aplica hasta que confirmes. Los enlaces son de un solo uso, vencen en 7 días y solo aplican a esta versión exacta. No reenvíes este correo: quien tenga los enlaces puede tomar la decisión.";

const REQUEST_CHANGES_PENDING_NOTE = "Pedir cambios respondiendo a este correo estará disponible próximamente.";

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

interface ActionButton {
  label: string;
  url: string;
  background: string;
}

/** Functional decision buttons (HTML) with the same URLs spelled out for the plain-text alternative. */
function actionsSection(buttons: ActionButton[], extraNote: string | null): Section {
  const buttonsHtml = buttons
    .map(
      (b) =>
        `<a href="${escapeHtml(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:6px;background:${b.background};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${escapeHtml(b.label)}</a>`
    )
    .join("");
  const notes = [ACTION_SECURITY_NOTE, extraNote].filter((n): n is string => Boolean(n));
  return {
    html: `<div style="margin:28px 0 8px;padding:12px;border:1px solid #ddd;border-radius:6px"><h2 style="font-size:16px;margin:0 0 12px">Decisión</h2><div>${buttonsHtml}</div>${notes
      .map((n) => `<p style="font-size:12px;color:#666;margin:8px 0 0">${escapeHtml(n)}</p>`)
      .join("")}</div>`,
    text: `-- Decisión --\n${buttons.map((b) => `${b.label}: ${b.url}`).join("\n")}\n\n${notes.join("\n")}`,
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
    input.actions
      ? actionsSection(
          [
            { label: "Aprobar", url: input.actions.approveUrl, background: "#15803d" },
            { label: "Rechazar", url: input.actions.rejectUrl, background: "#b91c1c" },
          ],
          REQUEST_CHANGES_PENDING_NOTE
        )
      : pendingActionsSection(),
  ]);

  return {
    subject: sanitizeSubject(`[${brandDisplayName}] Revisión de contenido v${draft.version}: ${displayTitle(draft)}`),
    html,
    text,
  };
}

// ---------------------------------------------------------------------
// Finished-publication review email (stage 2: the exact image + exact
// final caption for the draft's single destination channel, pending review)
// ---------------------------------------------------------------------

const isCarouselAsset = (asset: ContentAssetRow) => asset.format === "carousel";

/**
 * Deterministic intra-carousel findings (lib/agent/carouselPlan.ts)
 * that the Visual Director did not declare intentional: slides showing
 * the identical visual treatment. Surfaced to the human reviewer; never
 * model reasoning.
 */
function unresolvedRepeatWarnings(asset: ContentAssetRow): string[] {
  const visualPlan = (asset.render_provenance as { visualPlan?: { intraCarouselRepeats?: unknown } } | null)?.visualPlan;
  const repeats = Array.isArray(visualPlan?.intraCarouselRepeats) ? (visualPlan!.intraCarouselRepeats as { slides?: unknown; justified?: unknown }[]) : [];
  return repeats
    .filter((r) => r.justified !== true && Array.isArray(r.slides) && r.slides.length > 1)
    .map((r) => {
      const slides = (r.slides as number[]).map(String);
      const list = slides.length === 2 ? `${slides[0]} y ${slides[1]}` : `${slides.slice(0, -1).join(", ")} y ${slides.at(-1)}`;
      return `Las diapositivas ${list} muestran el mismo tratamiento visual (misma fuente y composición).`;
    });
}

/**
 * Every slide of a carousel asset, in publication order: "Diapositiva
 * i/N", the exact image, and the approved text drawn on it (plus the CTA
 * button on the last slide). One section — the carousel is approved once.
 */
function carouselSlidesSection(input: AssetReviewEmailInput): Section {
  const { draft, asset } = input;
  const records = asset.slides ?? [];
  const images = input.slideImages ?? [];
  const texts = new Map(slidesOf(draft).map((s) => [s.slide, s.text]));
  const total = records.length;
  const { label: ctaLabel } = resolveCtaLabelAndUrl(draft);
  const html: string[] = [`<h2 style="font-size:16px;margin:24px 0 8px">Carrusel (${total} imágenes, en el orden en que se publicarán)</h2>`];
  const text: string[] = [`== Carrusel (${total} imágenes, en el orden en que se publicarán) ==`];
  for (const warning of unresolvedRepeatWarnings(asset)) {
    html.push(`<p style="font-size:13px;color:#a33;margin:8px 0">${escapeHtml(warning)}</p>`);
    text.push(`ATENCIÓN: ${warning}`);
  }
  records.forEach((record, i) => {
    const heading = `Diapositiva ${record.position}/${total}`;
    const slideText = texts.get(record.position) ?? "";
    const cta = record.position === total && nonEmpty(ctaLabel) ? ctaLabel : null;
    const image = images[i];
    html.push(
      `<h3 style="font-size:14px;margin:20px 0 6px">${escapeHtml(heading)}</h3>` +
        (image
          ? `<img src="cid:${escapeHtml(image.contentId)}" width="432" height="540" alt="${escapeHtml(`${heading} — ${displayTitle(draft)}`)}" style="display:block;max-width:100%;height:auto;border:1px solid #ddd;border-radius:4px">`
          : `<p style="font-size:14px;color:#a33">Imagen no disponible.</p>`) +
        `<div style="font-size:13px;color:#333;margin:6px 0 0;white-space:pre-wrap"><strong>Texto en la imagen:</strong> ${escapeHtml(slideText)}</div>` +
        (cta ? `<div style="font-size:13px;color:#333;margin:2px 0 0"><strong>Botón (CTA):</strong> ${escapeHtml(cta)}</div>` : "")
    );
    text.push(
      `-- ${heading} --\n` +
        (image ? `Imagen: adjunta en línea (${image.filename}).` : "Imagen: no disponible.") +
        `\nTexto en la imagen: ${slideText}` +
        (cta ? `\nBotón (CTA): ${cta}` : "")
    );
  });
  return { html: html.join(""), text: text.join("\n\n") };
}

function assetImageSection(input: AssetReviewEmailInput): Section {
  const { draft, asset, image } = input;
  if (isCarouselAsset(asset)) return carouselSlidesSection(input);
  if (draft.content_type === "carousel") {
    // Defensive: a carousel draft whose asset is not a carousel asset has
    // no slide images to show — never present a single image as the carousel.
    return {
      html: `<p style="font-size:14px;color:#555">Esta versión no contiene las imágenes del carrusel; abajo se muestran solo los textos de las diapositivas.</p>`,
      text: "Imagen: esta versión no contiene las imágenes del carrusel; se muestran solo los textos de las diapositivas.",
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

/** Prominent, unambiguous statement of the ONE channel this approval covers (draft.channel). */
function destinationSection(draft: ContentDraftRow): Section {
  const channel = CHANNEL_LABELS[draft.channel] ?? draft.channel;
  const note = `Esta aprobación autoriza solo ${channel}. No autoriza publicar en ningún otro canal.`;
  return {
    html: `<div style="margin:12px 0;padding:10px 12px;border-radius:6px;background:#f1f5f9;font-size:14px"><strong>Destino: ${escapeHtml(channel)}</strong><br><span style="color:#555;font-size:13px">${escapeHtml(note)}</span></div>`,
    text: `Destino: ${channel}\n${note}`,
  };
}

/** The exact caption the publisher will send — composed by the same canonical function the publishers use. */
function finalCaptionSection(draft: ContentDraftRow): Section {
  const channel = CHANNEL_LABELS[draft.channel] ?? draft.channel;
  const finalCaption = composeFinalSocialCaption(draft);
  if (!finalCaption) {
    return {
      html: `<h2 style="font-size:16px;margin:24px 0 8px">Texto final que se publicará</h2><p style="font-size:14px;color:#a33">Este borrador no tiene texto publicable (sin caption ni hook).</p>`,
      text: "== Texto final que se publicará ==\nEste borrador no tiene texto publicable (sin caption ni hook).",
    };
  }
  const note = `Este es exactamente el texto que se enviará a ${channel}, incluidos el enlace y los hashtags.`;
  return {
    html: `<h2 style="font-size:16px;margin:24px 0 8px">Texto final que se publicará</h2><div style="font-size:14px;white-space:pre-wrap;padding:12px;border:1px solid #ddd;border-radius:6px;background:#fafafa">${escapeHtml(
      finalCaption
    )}</div><p style="font-size:12px;color:#666;margin:6px 0 0">${escapeHtml(note)}</p>`,
    text: `== Texto final que se publicará ==\n${finalCaption}\n\n(${note})`,
  };
}

/** What the image renderer draws onto the image itself (assetRenderer.ts: draft.hook + CTA label). A carousel shows this per slide instead. */
function textInImageSection(draft: ContentDraftRow, asset: ContentAssetRow): Section | null {
  if (draft.content_type === "carousel" || isCarouselAsset(asset)) return null;
  const { label } = resolveCtaLabelAndUrl(draft);
  const rows = [field("Titular", draft.hook), field("Botón (CTA)", nonEmpty(label) ? label : null)];
  if (rows.every((r) => r === null)) return null;
  return fieldTable("Texto dentro de la imagen", rows);
}

export function renderAssetReviewEmail(input: AssetReviewEmailInput): RenderedEmailWithAttachments {
  const { brandDisplayName, draft, asset } = input;
  const channel = CHANNEL_LABELS[draft.channel] ?? draft.channel;
  const carousel = isCarouselAsset(asset);
  const slideCount = (asset.slides ?? []).length;
  const title = `Pieza lista para publicar — ${brandDisplayName}`;
  const intro = carousel
    ? `AlexAgent preparó el carrusel final para ${channel}: estas ${slideCount} imágenes, en este orden, y este texto exactos (contenido v${draft.version}, carrusel v${asset.asset_version}). Si estás de acuerdo, aprueba la publicación una sola vez.`
    : `AlexAgent preparó la pieza final para ${channel}: esta imagen y este texto exactos (contenido v${draft.version}, imagen v${asset.asset_version}). Si estás de acuerdo, aprueba la publicación.`;

  const assetFields: (Section | null)[] = carousel
    ? [
        field("Versión del carrusel", `v${asset.asset_version}`),
        field("Imágenes", `${slideCount}`),
        field("Generado desde el contenido", `v${asset.source_draft_version}`),
      ]
    : [field("Versión de la imagen", `v${asset.asset_version}`), field("Generada desde el contenido", `v${asset.source_draft_version}`)];
  const versionMismatch: Section | null =
    asset.source_draft_version !== draft.version
      ? {
          html: `<p style="font-size:13px;color:#a33">Atención: esta imagen se generó desde la versión v${asset.source_draft_version} del contenido, pero el contenido actual es v${draft.version}.</p>`,
          text: `ATENCIÓN: esta imagen se generó desde el contenido v${asset.source_draft_version}; el contenido actual es v${draft.version}.`,
        }
      : null;

  const publicationNote = carousel
    ? `"Aprobar publicación" autoriza únicamente ${channel}, con este carrusel exacto (${slideCount} imágenes en este orden) y este texto. Al confirmar, AlexAgent lo publicará automáticamente como UNA sola publicación en ${channel}; no se pedirá otra aprobación.`
    : `"Aprobar publicación" autoriza únicamente ${channel}, con esta imagen y este texto exactos. Al confirmar, AlexAgent la publicará automáticamente en ${channel}; no se pedirá otra aprobación.`;

  const { html, text } = wrapDocument(title, intro, [
    destinationSection(draft),
    assetImageSection(input),
    versionMismatch,
    finalCaptionSection(draft),
    textInImageSection(draft, asset),
    draft.content_type === "carousel" && !carousel ? slidesSection(draft) : null,
    contextSection(input, assetFields),
    input.approveAssetUrl
      ? actionsSection([{ label: "Aprobar publicación", url: input.approveAssetUrl, background: "#15803d" }], `${publicationNote} ${REQUEST_CHANGES_PENDING_NOTE}`)
      : pendingActionsSection(),
  ]);

  const inlineAttachments = carousel
    ? (input.slideImages ?? [])
    : draft.content_type !== "carousel" && input.image
      ? [input.image]
      : [];
  return {
    subject: sanitizeSubject(
      carousel
        ? `[${brandDisplayName}] Carrusel listo para publicar en ${channel}: ${displayTitle(draft)} (contenido v${draft.version}, carrusel v${asset.asset_version})`
        : `[${brandDisplayName}] Pieza lista para publicar en ${channel}: ${displayTitle(draft)} (contenido v${draft.version}, imagen v${asset.asset_version})`
    ),
    html,
    text,
    inlineAttachments,
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

/**
 * Every slide image of a carousel asset, in its authoritative order, as
 * CID inline attachments (brand + asset version + position only — no
 * internal ids or paths). Throws if ANY slide can't be read: a carousel
 * review must never go out incomplete (the caller marks the notification
 * failed and a later attempt retries without regenerating anything).
 */
export async function loadCarouselInlineImages(storage: AssetStorage, asset: ContentAssetRow): Promise<EmailInlineAttachment[]> {
  const brandSlug = asset.brand.replace(/[^A-Za-z0-9-]/g, "") || "asset";
  const slides = asset.slides ?? [];
  if (slides.length === 0) throw new Error("Carousel asset has no stored slides.");
  return Promise.all(
    slides.map(async (slide) => ({
      contentId: `${brandSlug}-carousel-v${asset.asset_version}-slide-${slide.position}`,
      filename: `${brandSlug}-carousel-v${asset.asset_version}-slide-${slide.position}.${extensionFor(slide.mime_type)}`,
      contentType: slide.mime_type,
      content: await storage.download(slide.storage_path),
    }))
  );
}
