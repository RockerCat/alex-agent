import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// Real production incident (2026-09-25): every renderer-drawn string in a
// real SolarDesk asset (headline, disclosure, CTA — even plain ASCII)
// came out as replacement boxes, because SVG <text> depended on host
// fonts that the Vercel runtime doesn't have, while local macOS rendered
// fine. The renderer now outlines all of its own text from a bundled
// font. These tests use the real bundled font files, never mocked
// coverage.
//
// Every SVG handed to sharp() is captured (pass-through wrapper) so the
// tests can prove Sharp never receives live text that would need a host
// font.

const captured = vi.hoisted(() => ({ svgs: [] as string[] }));
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: (...args: unknown[]) => unknown };
  const real = actual.default;
  const wrapped = (input: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(input) && input.subarray(0, 512).toString("utf8").includes("<svg")) {
      captured.svgs.push(input.toString("utf8"));
    }
    return real(input, ...rest);
  };
  Object.assign(wrapped, real);
  return { ...actual, default: wrapped };
});

import sharp from "sharp";
import { renderImagePostAsset, AssetRenderError, ctaFitsAtEmphasis, IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT } from "@/lib/agent/assetRenderer";
import { PROPOSAL_EXAMPLE } from "@/lib/agent/proposalExamples";
import { getScreenshotMeta } from "@/lib/agent/productScreenshots";
import { getBundledFont, findMissingGlyphs, outlineText, TextOutlineError, BUNDLED_FONT_NAME } from "@/lib/agent/textOutline";
import { tinyPngBuffer } from "@/tests/support/fakeImageGenerationClient";

// Characters SolarDesk copy uses (Spanish + punctuation the Executor and
// renderer actually emit, incl. the disclosure's middle dot and curly quotes).
const SOLARDESK_CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  "áéíóúÁÉÍÓÚñÑüÜ¿¡·“”‘’–—… .,;:!?\"'()[]/%$#&+-*=@";

// The exact real production piece whose v1 rendered as boxes.
const PRODUCTION_PIECE = {
  headline: "Prueba SolarDesk con una propuesta profesional gratis cada mes.",
  ctaText: "Comenzar gratis",
  renderSpec: { ctaEmphasis: "strong", logoEmphasis: "normal", disclosureEmphasis: "normal", primaryVisualScale: "large", secondaryPageVisibility: "subtle" },
  strategy: "proposal_document",
  forceProposalMeta: PROPOSAL_EXAMPLE,
  forceScreenshotMeta: null,
} as const;

/** Horizontal ink extent of an outlined line rasterized alone on a transparent canvas. */
async function inkExtent(pathSvg: string, width = 1080, height = 200) {
  const png = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${pathSvg}</svg>`))
    .png()
    .toBuffer();
  const { info } = await sharp(png).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer({ resolveWithObject: true });
  const left = -(info.trimOffsetLeft ?? 0);
  return { left, right: left + info.width, width: info.width };
}

beforeEach(() => {
  captured.svgs.length = 0;
});

describe("bundled font", () => {
  it("regular and bold Liberation Sans both load from the repo", async () => {
    for (const weight of ["regular", "bold"] as const) {
      const font = await getBundledFont(weight);
      expect(font.names.fontFamily.en).toBe("Liberation Sans");
      expect(font.names.fontSubfamily.en).toBe(weight === "bold" ? "Bold" : "Regular");
    }
    expect(BUNDLED_FONT_NAME).toBe("Liberation Sans 2.1.5");
  });

  it("the license ships alongside the font files", async () => {
    const license = await readFile("assets/fonts/liberation-sans/LICENSE", "utf-8");
    expect(license).toContain("SIL Open Font License");
  });

  it("covers every character SolarDesk copy uses, in both weights", async () => {
    for (const weight of ["regular", "bold"] as const) {
      expect(findMissingGlyphs(await getBundledFont(weight), SOLARDESK_CHARSET)).toEqual([]);
    }
  });

  it("reports characters it cannot draw by code point (emoji checked as one code point)", async () => {
    const font = await getBundledFont("bold");
    expect(findMissingGlyphs(font, "Hola 😀 中中")).toEqual(["U+1F600", "U+4E2D"]);
  });
});

describe("outlineText", () => {
  it("emits a single <path> of real outlines — no live text", async () => {
    const svg = await outlineText({ label: "test", lines: [{ text: "Comenzar gratis", x: 540, y: 100 }], weight: "bold", fontSize: 40, fill: "#0F172A" });
    expect(svg).toMatch(/^<path d="M[^"]+" fill="#0F172A" \/>$/);
    expect(svg).not.toMatch(/<text|font-family/);
  });

  it("uses the font's real glyph metrics: distinct glyphs, not same-width boxes", async () => {
    const narrow = await inkExtent(await outlineText({ label: "t", lines: [{ text: "iiiiiiii", x: 540, y: 120 }], weight: "bold", fontSize: 60, fill: "#fff" }));
    const wide = await inkExtent(await outlineText({ label: "t", lines: [{ text: "MMMMMMMM", x: 540, y: 120 }], weight: "bold", fontSize: 60, fill: "#fff" }));
    expect(wide.width).toBeGreaterThan(narrow.width * 2.5);
  });

  it("centers each line on its x using real advance widths (like text-anchor=middle)", async () => {
    for (const text of ["Comenzar gratis", "Propuesta de ejemplo · Valores ilustrativos", "¿Sigues armando propuestas?"]) {
      const ink = await inkExtent(await outlineText({ label: "t", lines: [{ text, x: 540, y: 120 }], weight: "bold", fontSize: 40, fill: "#fff" }));
      expect(Math.abs((ink.left + ink.right) / 2 - 540)).toBeLessThanOrEqual(4);
    }
  });

  it("fails closed on a missing glyph, naming only code points — never the text itself", async () => {
    const attempt = outlineText({ label: "approved CTA", lines: [{ text: "Secreto 🔒 interno", x: 540, y: 100 }], weight: "bold", fontSize: 40, fill: "#fff" });
    await expect(attempt).rejects.toBeInstanceOf(TextOutlineError);
    await expect(attempt).rejects.toThrow("The approved CTA contains characters the bundled renderer font (Liberation Sans 2.1.5) cannot draw: U+1F512.");
    await expect(attempt).rejects.not.toThrow(/Secreto|interno/);
  });
});

describe("renderImagePostAsset — deterministic typography", () => {
  const LAYOUTS = {
    "text-only": { headline: "Titulo de prueba", ctaText: "Comenzar gratis", assetVersion: 1 },
    product: {
      headline: "Gestiona tus proyectos solares",
      ctaText: "Comenzar gratis",
      assetVersion: 1,
      strategy: "product_screenshot",
      forceScreenshotMeta: getScreenshotMeta("04.png")!,
      forceProposalMeta: null,
    },
    proposal: { ...PRODUCTION_PIECE, assetVersion: 1 },
    hero: { headline: "Energía solar para tu empresa", ctaText: "Comenzar gratis", assetVersion: 1, strategy: "generated_photo", generatedImage: tinyPngBuffer() },
    "hybrid-proposal": {
      headline: "Tu primera propuesta solar",
      ctaText: "Comenzar gratis",
      assetVersion: 2,
      strategy: "hybrid",
      generatedImage: tinyPngBuffer(),
      forceProposalMeta: PROPOSAL_EXAMPLE,
      forceScreenshotMeta: null,
    },
  } as const;

  it.each(Object.entries(LAYOUTS))("%s layout: Sharp never receives live text or a font request", async (_name, input) => {
    const result = await renderImagePostAsset(input as Parameters<typeof renderImagePostAsset>[0]);

    expect(captured.svgs.length).toBeGreaterThan(0);
    for (const svg of captured.svgs) {
      expect(svg).not.toMatch(/<text|<tspan|font-family|font-size|@font-face/);
    }
    // headline + CTA (+ disclosure where shown) are all outlined paths
    const outlinedPaths = captured.svgs.join("").match(/<path d="M/g) ?? [];
    expect(outlinedPaths.length).toBeGreaterThanOrEqual(2);
    expect(result.provenance.typography).toEqual({ method: "outlined-paths", font: "Liberation Sans 2.1.5" });

    const meta = await sharp(result.png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT]);
  });

  it("the proposal layout outlines headline, disclosure and CTA (three text paths, disclosure muted)", async () => {
    await renderImagePostAsset({ ...PRODUCTION_PIECE, assetVersion: 2 });
    const svg = captured.svgs.find((s) => s.includes('fill="#0F172A" />') && s.includes("fill-opacity=\"0.62\""))!;
    expect(svg).toBeDefined();
    expect(svg.match(/<path d="M/g)).toHaveLength(3);
  });

  it("the exact production piece re-renders with ink in the headline and CTA regions (regression for v1's boxes)", async () => {
    const result = await renderImagePostAsset({ ...PRODUCTION_PIECE, assetVersion: 2 });
    // CTA pill center row: navy outlined text inside the amber pill means
    // many non-amber pixels across the pill's middle.
    const { data, info } = await sharp(result.png).extract({ left: 340, top: 1245, width: 400, height: 10 }).raw().toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] < 100 && data[i + 1] < 100) dark++;
    expect(dark).toBeGreaterThan(200);
  });

  it("Spanish accents, ñ, ¿¡, middle dot and curly quotes render in headline and CTA", async () => {
    const result = await renderImagePostAsset({
      headline: "¿Sigues armando propuestas en “hojas de cálculo”? Ñandú · ÁÉÍÓÚ ü ¡Ya!",
      ctaText: "Crea tu cotización",
      assetVersion: 1,
    });
    expect((await sharp(result.png).metadata()).format).toBe("png");
  });

  it("fails closed with AssetRenderError when the headline has a glyph the bundled font lacks", async () => {
    const attempt = renderImagePostAsset({ headline: "Energía solar ☀️ para tu empresa", ctaText: "Comenzar gratis", assetVersion: 1 });
    await expect(attempt).rejects.toBeInstanceOf(AssetRenderError);
    await expect(attempt).rejects.toThrow(/approved headline .*U\+2600/);
  });

  it("fails closed with AssetRenderError when the CTA has a glyph the bundled font lacks (hero layout too)", async () => {
    const attempt = renderImagePostAsset({ headline: "Hola", ctaText: "Empieza 🚀", assetVersion: 1, strategy: "generated_photo", generatedImage: tinyPngBuffer() });
    await expect(attempt).rejects.toBeInstanceOf(AssetRenderError);
    await expect(attempt).rejects.toThrow(/approved CTA .*U\+1F680/);
  });

  it("wrap/fit behavior is unchanged: the same CTA feasibility answers as before", () => {
    expect(ctaFitsAtEmphasis("Comenzar gratis", "strong")).toBe(true);
    expect(ctaFitsAtEmphasis("Crea tu primera cotización", "normal")).toBe(true);
    expect(ctaFitsAtEmphasis("Palabra ".repeat(20).trim(), "subtle")).toBe(false);
  });

  it("the renderer source never emits live SVG text or asks for a system font", async () => {
    const source = await readFile("lib/agent/assetRenderer.ts", "utf-8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/<text[\s>]|<tspan|font-family=/);
  });

  it("is fully deterministic: same input → byte-identical PNG", async () => {
    const a = await renderImagePostAsset({ ...PRODUCTION_PIECE, assetVersion: 2 });
    const b = await renderImagePostAsset({ ...PRODUCTION_PIECE, assetVersion: 2 });
    expect(Buffer.compare(a.png, b.png)).toBe(0);
  });
});
