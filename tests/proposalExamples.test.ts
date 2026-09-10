import { describe, it, expect } from "vitest";
import { selectProposalExample, PROPOSAL_EXAMPLE, PROPOSAL_RENDERED_DIR } from "@/lib/agent/proposalExamples";

describe("selectProposalExample", () => {
  it("selects the verified proposal example when the brief asks to show the client-facing output/PDF", () => {
    const result = selectProposalExample({
      visualDirection: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente, lista para presentar.",
      purpose: "activation",
      topic: "El resultado: una propuesta profesional para tu cliente",
    });
    expect(result).not.toBeNull();
    expect(result?.sourceType).toBe("proposal-example");
  });

  it("selects the proposal example for a bare, unqualified proposal mention (no management signal)", () => {
    const result = selectProposalExample({
      visualDirection: "Habla de tu propuesta solar.",
      purpose: "activation",
      topic: "propuesta",
    });
    expect(result).not.toBeNull();
  });

  it("yields (returns null) when the brief is clearly about the internal management/listing screen", () => {
    const result = selectProposalExample({
      visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      purpose: "activation",
      topic: "Gestiona tus propuestas solares",
    });
    expect(result).toBeNull();
  });

  it("returns null when nothing proposal/output related is mentioned", () => {
    const result = selectProposalExample({
      visualDirection: "SaaS B2B limpio, azul oscuro y ámbar.",
      purpose: "activation",
      topic: "Comienza gratis en SolarDesk",
    });
    expect(result).toBeNull();
  });

  it("the verified proposal example always points at proposal-examples/, never references/", () => {
    expect(PROPOSAL_EXAMPLE.pdfPath).toContain("proposal-examples/");
    expect(PROPOSAL_EXAMPLE.pdfPath).not.toContain("references");
    expect(PROPOSAL_RENDERED_DIR).toContain("proposal-examples/");
    expect(PROPOSAL_RENDERED_DIR).not.toContain("references");
    for (const page of PROPOSAL_EXAMPLE.pages) {
      expect(page.file).not.toContain("references");
      expect(page.file).not.toContain("/");
    }
  });

  it("the metadata always marks example-specific figures and the mandatory fictitious label", () => {
    expect(PROPOSAL_EXAMPLE.hasExampleSpecificFigures).toBe(true);
    expect(PROPOSAL_EXAMPLE.requiresFictitiousLabel).toBe(true);
  });
});
