import { describe, it, expect } from "vitest";
import { selectProductScreenshot, getScreenshotMeta } from "@/lib/agent/productScreenshots";

describe("selectProductScreenshot", () => {
  it("returns null when nothing in the brief calls for product imagery", () => {
    const result = selectProductScreenshot({
      visualDirection: "SaaS B2B limpio, azul oscuro y ámbar.",
      purpose: "activation",
      topic: "Comienza gratis en SolarDesk",
    });
    expect(result).toBeNull();
  });

  it("selects the verified proposals-list screenshot (04.png) when the brief calls for proposal imagery", () => {
    const result = selectProductScreenshot({
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });
    expect(result?.file).toBe("04.png");
  });

  it("selects a dashboard/product-overview screenshot for generic product language without proposal wording", () => {
    const result = selectProductScreenshot({
      visualDirection: "Muestra la plataforma y el dashboard de producto.",
      purpose: "activation",
      topic: "Conoce la plataforma",
    });
    expect(result?.showsProductOverview).toBe(true);
  });

  it("never selects anything from brands/solardesk/assets/references/ — only real product-screenshots entries exist in the catalog", () => {
    const proposalMatch = selectProductScreenshot({
      visualDirection: "propuesta",
      purpose: "activation",
      topic: "propuesta",
    });
    const overviewMatch = selectProductScreenshot({
      visualDirection: "dashboard",
      purpose: "activation",
      topic: "producto",
    });
    for (const meta of [proposalMatch, overviewMatch]) {
      expect(meta).not.toBeNull();
      expect(meta!.file).not.toContain("references");
      expect(getScreenshotMeta(meta!.file)).toBeDefined();
    }
  });

  it("the pricing/subscription screenshot (09.png) is never returned by selection, even though it is in the catalog", () => {
    for (const brief of [
      { visualDirection: "precio plan suscripción", purpose: "activation", topic: "producto" },
      { visualDirection: "dashboard producto plataforma", purpose: "activation", topic: "propuestas" },
    ]) {
      const result = selectProductScreenshot(brief);
      expect(result?.file).not.toBe("09.png");
    }
  });

  it("every catalog entry's mask regions fall within its own safe crop region (no mask references pixels outside the crop)", () => {
    for (const file of ["01.png", "02.png", "03.png", "04.png", "05.png", "06.png", "07.png", "08.png", "09.png"]) {
      const meta = getScreenshotMeta(file);
      expect(meta).toBeDefined();
      for (const mask of meta!.maskRegions) {
        expect(mask.x).toBeGreaterThanOrEqual(meta!.safeCropRegion.x);
        expect(mask.y).toBeGreaterThanOrEqual(meta!.safeCropRegion.y);
        expect(mask.x + mask.width).toBeLessThanOrEqual(meta!.safeCropRegion.x + meta!.safeCropRegion.width);
        expect(mask.y + mask.height).toBeLessThanOrEqual(meta!.safeCropRegion.y + meta!.safeCropRegion.height);
      }
    }
  });
});
