import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderImagePostAsset, AssetRenderError, IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT } from "@/lib/agent/assetRenderer";

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
});
