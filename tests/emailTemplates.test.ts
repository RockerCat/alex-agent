import { describe, it, expect } from "vitest";
import type { ContentAssetRow, ContentDraftRow, ContentRevisionRow } from "@/lib/types/database";
import { renderContentReviewEmail, renderAssetReviewEmail, loadAssetInlineImage, escapeHtml } from "@/lib/agent/emailTemplates";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";

// Review email rendering (Email HITL Phase 2A/2B): pure, provider-neutral,
// HTML-escaped, with a plain-text alternative. Without supplied action
// URLs there are NO functional links or AlexAgent URLs of any kind; with
// them (Phase 2B), only the supplied action buttons appear.

function draft(overrides: Partial<ContentDraftRow> = {}): ContentDraftRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    plan_id: "22222222-2222-4222-8222-222222222222",
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "Generar registros",
    topic: "Propuestas solares en minutos",
    audience: "Instaladores solares",
    cta: "Comenzar gratis",
    cta_url: "https://solardesk.co/register",
    target_date: "2026-09-25",
    status: "pending_approval",
    version: 2,
    title: "De la cotización a la propuesta",
    hook: "¿Cuántas horas pierdes armando propuestas?",
    body: { slides: [{ slide: 1, text: "Crea propuestas profesionales en minutos." }] },
    caption: "SolarDesk te ayuda a cerrar más proyectos.",
    cta_text: "Comenzar gratis",
    visual_direction: "Instalador revisando una propuesta en su laptop.",
    hashtags: ["#solar", "#energia"],
    blocked_on_question_id: null,
    approved_at: null,
    rejected_at: null,
    created_at: "2026-09-23T13:00:00Z",
    updated_at: "2026-09-23T13:00:00Z",
    ...overrides,
  };
}

function revision(overrides: Partial<ContentRevisionRow> = {}): ContentRevisionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    draft_id: "11111111-1111-4111-8111-111111111111",
    version: 2,
    title: null,
    hook: null,
    body: {},
    caption: null,
    cta_text: null,
    visual_direction: null,
    hashtags: [],
    source: "executor",
    feedback_category: "weak_hook",
    feedback_note: "Haz el hook más directo.",
    created_by_run: null,
    created_at: "2026-09-23T13:00:00Z",
    ...overrides,
  };
}

function asset(overrides: Partial<ContentAssetRow> = {}): ContentAssetRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    draft_id: "11111111-1111-4111-8111-111111111111",
    brand: "solardesk",
    asset_version: 3,
    source_draft_version: 2,
    status: "pending_review",
    format: "image_post",
    width: 1080,
    height: 1350,
    mime_type: "image/png",
    storage_bucket: "solardesk-assets",
    storage_path: "solardesk/draft/v3.png",
    render_provenance: {},
    slides: [],
    error_message: null,
    created_at: "2026-09-23T13:00:00Z",
    approved_at: null,
    ...overrides,
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** No action links of any kind: no anchors, no AlexAgent routes, no URL other than the CTA's own destination. */
function expectNoFunctionalLinks(html: string, text: string) {
  expect(html).not.toMatch(/<a[\s>]/i);
  expect(html).not.toMatch(/href\s*=/i);
  for (const body of [html, text]) {
    expect(body).not.toMatch(/approvals\//);
    expect(body).not.toMatch(/\/email\/action/);
    expect(body).not.toMatch(/token/i);
    const urls = body.match(/https?:\/\/[^\s<"')]+/g) ?? [];
    expect(urls.every((u) => u === "https://solardesk.co/register")).toBe(true);
  }
}

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });
});

describe("renderContentReviewEmail", () => {
  it("renders every existing content field in both HTML and plain text", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), planObjective: "SIGNUPS", latestRevision: revision() });

    expect(email.subject).toBe("[SolarDesk] Revisión de contenido v2: De la cotización a la propuesta");
    const expectedValues = [
      "SolarDesk",
      "Instagram",
      "Imagen (image_post)",
      "v2",
      "2026-09-25",
      "SIGNUPS",
      "Generar registros",
      "Propuestas solares en minutos",
      "Instaladores solares",
      "De la cotización a la propuesta",
      "¿Cuántas horas pierdes armando propuestas?",
      "Crea propuestas profesionales en minutos.",
      "SolarDesk te ayuda a cerrar más proyectos.",
      "#solar #energia",
      "Comenzar gratis",
      "https://solardesk.co/register",
      "Instalador revisando una propuesta en su laptop.",
      "Hook débil",
      "Haz el hook más directo.",
    ];
    for (const value of expectedValues) {
      expect(email.html).toContain(escapeHtml(value));
      expect(email.text).toContain(value);
    }
  });

  it("escapes model-generated values in HTML (no injected markup) while keeping them readable in text", () => {
    const hostile = `<img src=x onerror="alert(1)"><a href="https://evil.test">click</a>`;
    const email = renderContentReviewEmail({
      brandDisplayName: "SolarDesk",
      draft: draft({ title: hostile, hook: hostile, caption: hostile, visual_direction: hostile, hashtags: [hostile], body: { slides: [{ slide: 1, text: hostile }] } }),
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain('<a href="https://evil.test"');
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(email.text).toContain(hostile);
  });

  it("keeps the subject to a single, bounded header line", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft({ title: `Línea 1\r\nBcc: attacker@example.test\n${"x".repeat(300)}` }) });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject.length).toBeLessThanOrEqual(150);
  });

  it("renders all carousel slide texts in order", () => {
    const email = renderContentReviewEmail({
      brandDisplayName: "SolarDesk",
      draft: draft({
        content_type: "carousel",
        body: {
          slides: [
            { slide: 2, text: "Segunda diapositiva" },
            { slide: 1, text: "Primera diapositiva" },
            { slide: 3, text: "Tercera diapositiva" },
          ],
        },
      }),
    });
    expect(email.html).toContain("Textos de las diapositivas");
    expect(email.text).toMatch(/1\. Primera diapositiva\n2\. Segunda diapositiva\n3\. Tercera diapositiva/);
  });

  it("omits the revision summary when the revision is for a different version or has no feedback", () => {
    const stale = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), latestRevision: revision({ version: 1 }) });
    const noFeedback = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), latestRevision: revision({ feedback_category: null, feedback_note: null }) });
    for (const email of [stale, noFeedback]) {
      expect(email.text).not.toContain("Cambios solicitados");
    }
  });

  it("renders a legacy combined CTA string's URL as plain text", () => {
    const email = renderContentReviewEmail({
      brandDisplayName: "SolarDesk",
      draft: draft({ cta_url: null, cta_text: "Comenzar gratis — https://solardesk.co/register" }),
    });
    expect(email.text).toContain("Texto del CTA: Comenzar gratis");
    expect(email.text).toContain("Destino del CTA (solo referencia): https://solardesk.co/register");
  });

  it("contains no functional approve/reject links — only a non-functional placeholder", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), planObjective: "SIGNUPS", latestRevision: revision() });
    expectNoFunctionalLinks(email.html, email.text);
    expect(email.text).toContain("estará disponible próximamente");
  });
});

describe("renderAssetReviewEmail", () => {
  const image = { contentId: "solardesk-asset-v3", filename: "solardesk-asset-v3.png", contentType: "image/png", content: PNG };

  it("renders the finished post: inline CID image, exact destination, exact final caption, and both versions", () => {
    const email = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft({ status: "approved" }), asset: asset(), planObjective: "SIGNUPS", image });

    expect(email.subject).toBe("[SolarDesk] Pieza lista para publicar en Instagram: De la cotización a la propuesta (contenido v2, imagen v3)");
    expect(email.text).toContain("Pieza lista para publicar");
    expect(email.html).toContain('src="cid:solardesk-asset-v3"');
    expect(email.html).toContain('width="540" height="675"');
    expect(email.inlineAttachments).toEqual([image]);
    // Exact destination, stated as the only authorized channel.
    expect(email.text).toContain("Destino: Instagram");
    expect(email.text).toContain("Esta aprobación autoriza solo Instagram.");
    // The exact string the publisher will send (canonical composer), not separate fields.
    const finalCaption = composeFinalSocialCaption(draft({ status: "approved" }));
    expect(finalCaption).toBe("SolarDesk te ayuda a cerrar más proyectos.\n\nhttps://solardesk.co/register\n\n#solar #energia");
    expect(email.text).toContain(`== Texto final que se publicará ==\n${finalCaption}\n`);
    expect(email.html).toContain(escapeHtml(finalCaption));
    // Text rendered inside the image, and both versions.
    expect(email.text).toContain("Titular: ¿Cuántas horas pierdes armando propuestas?");
    expect(email.text).toContain("Botón (CTA): Comenzar gratis");
    expect(email.text).toContain("Versión del contenido: v2");
    expect(email.text).toContain("Versión de la imagen: v3");
    expect(email.text).toContain("Imagen: adjunta en línea (solardesk-asset-v3.png)");
    expect(email.html).not.toMatch(/supabase|signed|storage\/v1/i);
  });

  it("flags an asset generated from an older content version", () => {
    const email = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft({ version: 3 }), asset: asset({ source_draft_version: 2 }), image });
    expect(email.text).toContain("ATENCIÓN: esta imagen se generó desde el contenido v2; el contenido actual es v3.");
  });

  it("renders a clear notice and no attachment when no image is available", () => {
    const email = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), asset: asset(), image: null });
    expect(email.html).not.toContain("cid:");
    expect(email.inlineAttachments).toEqual([]);
    expect(email.text).toContain("Imagen: no disponible");
  });

  it("defensive: a carousel draft whose asset isn't a carousel asset shows slide texts only and never attaches an image", () => {
    const email = renderAssetReviewEmail({
      brandDisplayName: "SolarDesk",
      draft: draft({ content_type: "carousel", body: { slides: [{ slide: 1, text: "Uno" }, { slide: 2, text: "Dos" }, { slide: 3, text: "Tres" }] } }),
      asset: asset(),
      image,
    });
    expect(email.html).not.toContain("cid:");
    expect(email.inlineAttachments).toEqual([]);
    expect(email.text).toContain("esta versión no contiene las imágenes del carrusel");
    expect(email.text).toMatch(/1\. Uno\n2\. Dos\n3\. Tres/);
  });

  it("contains no functional approve/reject links", () => {
    const email = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), asset: asset(), image });
    expectNoFunctionalLinks(email.html, email.text);
  });
});

describe("loadAssetInlineImage", () => {
  it("reads the image through AssetStorage.download and names it without internal ids", async () => {
    const storage = new FakeAssetStorage();
    storage.files.set("solardesk/draft/v3.png", PNG);
    const image = await loadAssetInlineImage(storage, asset());
    expect(image).toEqual({ contentId: "solardesk-asset-v3", filename: "solardesk-asset-v3.png", contentType: "image/png", content: PNG });
    expect(JSON.stringify({ id: image?.contentId, f: image?.filename })).not.toContain("4444");
  });

  it("returns null (never throws) for a failed asset, a missing path, or a missing file", async () => {
    const storage = new FakeAssetStorage();
    expect(await loadAssetInlineImage(storage, asset({ status: "generation_failed" }))).toBeNull();
    expect(await loadAssetInlineImage(storage, asset({ storage_path: null }))).toBeNull();
    expect(await loadAssetInlineImage(storage, asset())).toBeNull();
  });
});

describe("functional review actions (Phase 2B)", () => {
  const APPROVE = "https://agent.alexsosa.me/email/action#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const REJECT = "https://agent.alexsosa.me/email/action#t=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const APPROVE_ASSET = "https://agent.alexsosa.me/email/action#t=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

  it("renders Aprobar/Rechazar buttons and spells the same URLs out in text/plain", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), actions: { approveUrl: APPROVE, rejectUrl: REJECT } });
    expect(email.html).toContain(`<a href="${APPROVE}"`);
    expect(email.html).toContain(`<a href="${REJECT}"`);
    expect(email.html).toMatch(/>Aprobar<\/a>/);
    expect(email.html).toMatch(/>Rechazar<\/a>/);
    expect(email.text).toContain(`Aprobar: ${APPROVE}`);
    expect(email.text).toContain(`Rechazar: ${REJECT}`);
    expect(email.text).not.toContain("estará disponible próximamente. Por ahora este correo es solo informativo");
    // Only the two action anchors exist — the CTA destination is still plain text.
    expect(email.html.match(/<a\s/g)).toHaveLength(2);
    expect(email.html).not.toContain('href="https://solardesk.co');
  });

  it("never renders Request Changes as a button, and never shows raw ids in labels/copy", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), actions: { approveUrl: APPROVE, rejectUrl: REJECT } });
    expect(email.html).not.toMatch(/>\s*(Pedir|Solicitar) cambios\s*<\/a>/i);
    expect(email.text).toContain("Pedir cambios respondiendo a este correo estará disponible próximamente.");
    expect(email.html).not.toContain(draft().id);
    expect(email.text).not.toContain(draft().id);
  });

  it("escapes action URLs placed in href attributes", () => {
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), actions: { approveUrl: 'https://x.test/"><script>', rejectUrl: REJECT } });
    expect(email.html).not.toContain('"><script>');
    expect(email.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("renders Aprobar publicación (single channel; confirming publishes automatically) while keeping the inline CID image", () => {
    const image = { contentId: "solardesk-asset-v3", filename: "solardesk-asset-v3.png", contentType: "image/png", content: PNG };
    const email = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), asset: asset(), image, approveAssetUrl: APPROVE_ASSET });
    expect(email.html).toContain(`<a href="${APPROVE_ASSET}"`);
    expect(email.html).toMatch(/>Aprobar publicación<\/a>/);
    expect(email.html).not.toMatch(/>Aprobar imagen<\/a>/);
    expect(email.text).toContain(`Aprobar publicación: ${APPROVE_ASSET}`);
    expect(email.text).toContain('"Aprobar publicación" autoriza únicamente Instagram, con esta imagen y este texto exactos.');
    expect(email.text).toContain("Al confirmar, AlexAgent la publicará automáticamente en Instagram; no se pedirá otra aprobación.");
    expect(email.html).toContain('src="cid:solardesk-asset-v3"');
    expect(email.inlineAttachments).toEqual([image]);
    expect(email.html).not.toMatch(/>Rechazar/);
  });

  it("renders no action URL at all when none is supplied", () => {
    const content = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), actions: null });
    const assetEmail = renderAssetReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), asset: asset(), image: null, approveAssetUrl: null });
    for (const e of [content, assetEmail]) {
      expect(e.html).not.toMatch(/<a[\s>]/);
      expect(e.text).not.toContain("/email/action");
    }
  });

  it("the security note's stated expiry matches the real token TTL", async () => {
    const { DEFAULT_ACTION_TOKEN_TTL_MS } = await import("@/lib/agent/emailActions");
    const email = renderContentReviewEmail({ brandDisplayName: "SolarDesk", draft: draft(), actions: { approveUrl: APPROVE, rejectUrl: REJECT } });
    const days = DEFAULT_ACTION_TOKEN_TTL_MS / (24 * 60 * 60 * 1000);
    expect(email.text).toContain(`vencen en ${days} días`);
  });
});
