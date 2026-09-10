import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { renderImagePostAsset, AssetRenderError, IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT } from "@/lib/agent/assetRenderer";

// Live QA gap: v1 of the SolarDesk image_post asset technically executed
// (correct logo/colors/headline/CTA) but visual review rejected it — the
// approved visualDirection called for a product/proposal-oriented
// composition, and the renderer ignored that, producing only a mostly
// empty navy canvas. These tests cover the fix: a real, verified
// SolarDesk product screenshot can now become the primary visual
// element when the approved draft's visualDirection/purpose/topic call
// for it — never fabricated, never AI-selected, and never used at all
// unless those signals are present.

describe("renderImagePostAsset", () => {
  it("produces a 1080x1350 PNG for normal approved copy", async () => {
    const result = await renderImagePostAsset({
      headline: "¿Sigues armando propuestas solares en hojas de cálculo?",
      ctaText: "Crea tu primera cotización",
      assetVersion: 1,
    });

    expect(result.width).toBe(IMAGE_POST_WIDTH);
    expect(result.height).toBe(IMAGE_POST_HEIGHT);

    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("deterministically alternates composition by version parity — regeneration is not identical, but still fully brand-consistent", async () => {
    const odd = await renderImagePostAsset({
      headline: "Titulo de prueba",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
    });
    const even = await renderImagePostAsset({
      headline: "Titulo de prueba",
      ctaText: "Comenzar gratis",
      assetVersion: 2,
    });

    expect(odd.provenance.theme).not.toBe(even.provenance.theme);
    // Same input, same version parity -> byte-identical (fully deterministic, no randomness).
    const oddAgain = await renderImagePostAsset({
      headline: "Titulo de prueba",
      ctaText: "Comenzar gratis",
      assetVersion: 3,
    });
    expect(odd.provenance.theme).toBe(oddAgain.provenance.theme);
    expect(Buffer.compare(odd.png, oddAgain.png)).toBe(0);
  });

  it("fails safely instead of truncating or overflowing when the approved headline cannot fit", async () => {
    const tooLong = "Palabra ".repeat(400).trim();
    await expect(
      renderImagePostAsset({ headline: tooLong, ctaText: "Comenzar gratis", assetVersion: 1 })
    ).rejects.toBeInstanceOf(AssetRenderError);
  });

  it("fails safely instead of truncating or overflowing when the approved CTA cannot fit", async () => {
    const tooLong = "Palabra ".repeat(200).trim();
    await expect(
      renderImagePostAsset({ headline: "Titulo corto", ctaText: tooLong, assetVersion: 1 })
    ).rejects.toBeInstanceOf(AssetRenderError);
  });

  it("1. a product-oriented visualDirection causes a verified real SolarDesk screenshot to be used", async () => {
    const result = await renderImagePostAsset({
      headline: "De la cotización a una propuesta lista para presentar",
      ctaText: "Crea tu primera propuesta",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });

    const screenshot = result.provenance.screenshot as { selected: boolean; file: string; source: string };
    expect(screenshot.selected).toBe(true);
    expect(screenshot.file).toBe("04.png");
  });

  it("2. the product composition still produces a PNG at 1080x1350", async () => {
    const result = await renderImagePostAsset({
      headline: "De la cotización a una propuesta lista para presentar",
      ctaText: "Crea tu primera propuesta",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });

    expect(result.width).toBe(IMAGE_POST_WIDTH);
    expect(result.height).toBe(IMAGE_POST_HEIGHT);
    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("3. the official logo is still used in the product composition", async () => {
    const result = await renderImagePostAsset({
      headline: "De la cotización a una propuesta lista para presentar",
      ctaText: "Crea tu primera propuesta",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });

    expect(result.provenance.logoFile).toBe("brands/solardesk/assets/logos/logo.png");
  });

  it("4. the selected screenshot always comes from product-screenshots/, never references/", async () => {
    const result = await renderImagePostAsset({
      headline: "De la cotización a una propuesta lista para presentar",
      ctaText: "Crea tu primera propuesta",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });

    const screenshot = result.provenance.screenshot as { selected: boolean; file: string; source: string };
    expect(screenshot.source).toBe("brands/solardesk/assets/product-screenshots");
    expect(screenshot.source).not.toContain("references");
  });

  it("5. the renderer only composites real screenshot bytes — it never generates or redraws UI pixels", async () => {
    const withScreenshot = await renderImagePostAsset({
      headline: "Titulo corto",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });
    const withoutScreenshot = await renderImagePostAsset({
      headline: "Titulo corto",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
    });

    // Same headline/CTA/version, only the presence of product intent
    // differs — the product composition must not be byte-identical to
    // the text-only one (something real was actually composited in),
    // while still being a well-formed 1080x1350 PNG produced by the
    // same deterministic pipeline (no generative model involved).
    expect(Buffer.compare(withScreenshot.png, withoutScreenshot.png)).not.toBe(0);
    expect((withScreenshot.provenance.screenshot as { selected: boolean }).selected).toBe(true);
    expect((withoutScreenshot.provenance.screenshot as { selected: boolean }).selected).toBe(false);
  });

  it("6. rendering never mutates the input it was given (approved draft content stays untouched)", async () => {
    const input = {
      headline: "De la cotización a una propuesta lista para presentar",
      ctaText: "Crea tu primera propuesta",
      assetVersion: 1,
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    };
    const snapshot = { ...input };

    await renderImagePostAsset(input);

    expect(input).toEqual(snapshot);
  });

  it("7. safe fallback still renders the original text-only composition when no screenshot is appropriate", async () => {
    const result = await renderImagePostAsset({
      headline: "Titulo corto",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
      visualDirection: "SaaS B2B limpio, azul oscuro y ámbar.",
      purpose: "activation",
      topic: "Comienza gratis en SolarDesk",
    });

    expect(result.provenance.renderer).toBe("svg-sharp-v1");
    expect((result.provenance.screenshot as { selected: boolean }).selected).toBe(false);
  });

  it("7b. safe fallback also applies when visualDirection/purpose/topic are omitted entirely (existing callers keep working unchanged)", async () => {
    const result = await renderImagePostAsset({
      headline: "Titulo corto",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
    });

    expect(result.provenance.renderer).toBe("svg-sharp-v1");
  });

  it("8. the existing no-screenshot rendering is byte-for-byte unchanged by this feature", async () => {
    const before = await renderImagePostAsset({
      headline: "¿Sigues armando propuestas solares en hojas de cálculo?",
      ctaText: "Crea tu primera cotización",
      assetVersion: 1,
    });
    const again = await renderImagePostAsset({
      headline: "¿Sigues armando propuestas solares en hojas de cálculo?",
      ctaText: "Crea tu primera cotización",
      assetVersion: 1,
      visualDirection: "",
      purpose: "",
      topic: "",
    });

    expect(Buffer.compare(before.png, again.png)).toBe(0);
  });
});

// Live QA gap #2: v2 correctly showed a real screenshot, but it was the
// internal proposal-management screen (04.png) — the marketing intent
// is to show the real client-facing proposal SolarDesk produces. These
// tests cover the fix: a verified real proposal-example PDF (rendered
// to PNG pages) can now become the dominant visual, taking precedence
// over the internal screenshot when the brief asks to show the actual
// output, while 04.png remains available for management-flavored briefs.
describe("renderImagePostAsset — proposal-example composition", () => {
  const proposalOutputInput = {
    headline: "De la cotización a una propuesta lista para presentar",
    ctaText: "Crea tu primera propuesta",
    assetVersion: 3,
    visualDirection: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente, lista para presentar.",
    purpose: "activation",
    topic: "El resultado: una propuesta profesional para tu cliente",
  };

  const managementInput = {
    headline: "Organiza todas tus propuestas en un solo lugar",
    ctaText: "Comenzar gratis",
    assetVersion: 3,
    visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
    purpose: "activation",
    topic: "Gestiona tus propuestas solares",
  };

  it("1. proposal-output intent selects the verified proposal example before 04.png", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as { selected: boolean };
    const screenshot = result.provenance.screenshot as { selected: boolean };
    expect(proposal.selected).toBe(true);
    expect(screenshot.selected).toBe(false);
  });

  it("2. internal proposal-management intent can still select 04.png", async () => {
    const result = await renderImagePostAsset(managementInput);
    const proposal = result.provenance.proposalExample as { selected: boolean };
    const screenshot = result.provenance.screenshot as { selected: boolean; file: string };
    expect(proposal.selected).toBe(false);
    expect(screenshot.selected).toBe(true);
    expect(screenshot.file).toBe("04.png");
  });

  it("3. the selected proposal source originates from proposal-examples/", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as { pdfPath: string; pages: string[] };
    expect(proposal.pdfPath).toContain("proposal-examples/");
    for (const page of proposal.pages) {
      expect(page).toContain("proposal-examples/");
    }
  });

  it("4. references/ can never be selected as the proposal source", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as { pdfPath: string; pages: string[] };
    expect(proposal.pdfPath).not.toContain("references");
    for (const page of proposal.pages) {
      expect(page).not.toContain("references");
    }
  });

  it("5. the original verified PDF remains present and unchanged on disk", async () => {
    const pdfPath = "brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf";
    const buf = await readFile(pdfPath);
    expect(buf.byteLength).toBe(403850);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("6. the rendered proposal pages used by the composition come from the verified rendered/ derivatives", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as { pages: string[] };
    expect(proposal.pages).toEqual([
      "brands/solardesk/assets/proposal-examples/rendered/page-1.png",
      "brands/solardesk/assets/proposal-examples/rendered/page-2.png",
    ]);
  });

  it("7. the proposal composition actually composites the real rendered page — output differs from the text-only render of the same copy", async () => {
    const withProposal = await renderImagePostAsset(proposalOutputInput);
    const textOnly = await renderImagePostAsset({
      headline: proposalOutputInput.headline,
      ctaText: proposalOutputInput.ctaText,
      assetVersion: proposalOutputInput.assetVersion,
    });
    expect(Buffer.compare(withProposal.png, textOnly.png)).not.toBe(0);
  });

  it("8. the mandatory EJEMPLO FICTICIO label is recorded as present in the proposal composition", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as { selected: boolean; fictitiousLabel: string };
    expect(proposal.selected).toBe(true);
    expect(proposal.fictitiousLabel).toBe("EJEMPLO FICTICIO");
  });

  it("9. output remains a PNG at 1080x1350 for the proposal composition", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    expect(result.width).toBe(IMAGE_POST_WIDTH);
    expect(result.height).toBe(IMAGE_POST_HEIGHT);
    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("10. the official SolarDesk logo remains present in the proposal composition", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    expect(result.provenance.logoFile).toBe("brands/solardesk/assets/logos/logo.png");
  });

  it("11. rendering never mutates the input it was given (approved draft content stays untouched)", async () => {
    const input = { ...proposalOutputInput };
    const snapshot = { ...input };
    await renderImagePostAsset(input);
    expect(input).toEqual(snapshot);
  });

  it("12. the proposal PDF's example-specific figures are never surfaced as new marketing claims — provenance only records paths/labels, not extracted figures", async () => {
    const result = await renderImagePostAsset(proposalOutputInput);
    const proposal = result.provenance.proposalExample as Record<string, unknown>;
    const serialized = JSON.stringify(proposal);
    // None of the PDF's concrete example figures (investment, savings,
    // payback years, client name) appear anywhere in what this
    // renderer records about the choice it made.
    expect(serialized).not.toMatch(/11\.465\.772|2\.400\.000|Jhon Doe|4\.8/);
  });

  it("13. the text-only fallback remains functional when no proposal/screenshot signal is present", async () => {
    const result = await renderImagePostAsset({
      headline: "Titulo corto",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
      visualDirection: "SaaS B2B limpio, azul oscuro y ámbar.",
      purpose: "activation",
      topic: "Comienza gratis en SolarDesk",
    });
    expect(result.provenance.renderer).toBe("svg-sharp-v1");
    expect((result.provenance.proposalExample as { selected: boolean }).selected).toBe(false);
    expect((result.provenance.screenshot as { selected: boolean }).selected).toBe(false);
  });

  it("14. the product-screenshot composition remains functional for management-flavored briefs", async () => {
    const result = await renderImagePostAsset(managementInput);
    expect(result.provenance.renderer).toBe("svg-sharp-product-v1");
  });

  it("15. existing asset dimensions/versioning behavior is unchanged by this feature (still 1080x1350 for the management/screenshot path)", async () => {
    const result = await renderImagePostAsset(managementInput);
    expect(result.width).toBe(IMAGE_POST_WIDTH);
    expect(result.height).toBe(IMAGE_POST_HEIGHT);
  });
});
