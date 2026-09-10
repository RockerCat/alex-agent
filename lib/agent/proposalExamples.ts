// Minimal, hand-verified metadata for the one verified SolarDesk
// client-facing proposal example: a real PDF SolarDesk generated,
// added at brands/solardesk/assets/proposal-examples/. This is
// deliberately NOT a document ingestion system — one fixed, known
// source, described just enough to (a) decide when an approved
// image_post should show the actual proposal output rather than the
// internal proposal-management screenshot (04.png, see
// productScreenshots.ts), and (b) compose it safely.
//
// The PDF itself is supporting visual evidence only, never Product
// Truth authority — its example-specific investment/savings/payback
// figures must never become marketing claims (see BRAND.md and
// VISUAL_IDENTITY.md for the general rule this follows).

/** Directory (repo-relative) holding the direct raster derivatives of the real PDF pages. Kept as a static constant, not part of each page's path, so callers can join it with a plain filename — the same statically-analyzable pattern productScreenshots.ts uses. */
export const PROPOSAL_RENDERED_DIR = "brands/solardesk/assets/proposal-examples/rendered";

export interface ProposalExamplePage {
  /** Filename under PROPOSAL_RENDERED_DIR — a direct raster derivative of the real PDF page, never redrawn or retypeset. */
  file: string;
  /** Concise, verified description of what is visibly shown on this page. */
  description: string;
  /**
   * How much of the derivative's own height (from the top, in its own
   * pixel space) is actual laid-out content, verified by direct visual
   * inspection. Both pages end in genuine trailing blank space (real
   * whitespace in the PDF's own layout, not something this renderer
   * adds) — cropping to this verified content height keeps the framed
   * preview from being dominated by that blank space, without cutting
   * or altering any real content.
   */
  contentHeight: number;
}

export interface ProposalExampleMeta {
  sourceType: "proposal-example";
  /** The original, unmodified, verified real PDF. */
  pdfPath: string;
  pages: [ProposalExamplePage, ProposalExamplePage];
  verifiedPurpose: string;
  /** Always true for this source: the PDF contains one project's concrete example figures, never universal SolarDesk outcomes. */
  hasExampleSpecificFigures: true;
  /** Always true: any marketing use of this source must visibly show "EJEMPLO FICTICIO". */
  requiresFictitiousLabel: true;
}

export const PROPOSAL_EXAMPLE: ProposalExampleMeta = {
  sourceType: "proposal-example",
  pdfPath: "brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf",
  pages: [
    {
      file: "page-1.png",
      description:
        "Proposal overview: installer/client identification, headline savings/payback figures, and investment/system summary tiles.",
      contentHeight: 2100,
    },
    {
      file: "page-2.png",
      description:
        "Financial and system-design detail: investment breakdown table, savings projection, payback chart, and system specifications.",
      contentHeight: 3120,
    },
  ],
  verifiedPurpose: "Verified real example of a client-facing solar proposal SolarDesk can generate for an installer's customer.",
  hasExampleSpecificFigures: true,
  requiresFictitiousLabel: true,
};

// Signals that the brief wants the actual client-facing deliverable —
// the finished proposal/PDF a customer would see — rather than the
// internal tool used to manage/list proposals.
const OUTPUT_SIGNAL_KEYWORDS = [
  "pdf",
  "documento",
  "entregable",
  "deliverable",
  "presentar",
  "presentación",
  "presentacion",
  "vista previa",
  "preview",
  "resultado",
  "propuesta final",
  "propuesta lista",
  "propuesta profesional",
  "propuesta terminada",
  "propuesta finalizada",
  "propuesta entregada",
  "cliente final",
  "propuesta al cliente",
  "client-facing",
  "proposal output",
  "proposal preview",
  "final proposal",
];

const PROPOSAL_WORD_KEYWORDS = ["propuesta", "propuestas", "cotización", "cotizacion", "cotizaciones", "quote", "proposal"];

// Signals that the brief is about the internal management/listing
// screen instead — when present (without an output signal), this
// module yields so the caller can fall back to the product-screenshot
// catalog (04.png), per VISUAL_IDENTITY.md's screenshot rules.
const MANAGEMENT_SIGNAL_KEYWORDS = [
  "gestiona",
  "gestionar",
  "organiza",
  "organizar",
  "administra",
  "administrar",
  "lista de propuestas",
  "listado de propuestas",
  "seguimiento",
  "dashboard",
  "plataforma",
  "interfaz",
  "interface",
  "pantalla",
  "screen",
  "mockup",
  "screenshot",
  "captura",
  "manage",
  "managing",
  "listing",
];

/**
 * Deterministic, keyword-based selection — not AI, not embeddings, no
 * document catalog. Returns the one verified proposal example when the
 * brief clearly asks to show the actual client-facing proposal/output,
 * and null otherwise (including when the brief is about the internal
 * proposal-management screen, so 04.png remains available for that).
 */
export function selectProposalExample(input: { visualDirection: string; purpose: string; topic: string }): ProposalExampleMeta | null {
  const text = `${input.visualDirection} ${input.purpose} ${input.topic}`.toLowerCase();

  if (OUTPUT_SIGNAL_KEYWORDS.some((k) => text.includes(k))) {
    return PROPOSAL_EXAMPLE;
  }

  const hasProposalWord = PROPOSAL_WORD_KEYWORDS.some((k) => text.includes(k));
  if (!hasProposalWord) return null;

  const hasManagementSignal = MANAGEMENT_SIGNAL_KEYWORDS.some((k) => text.includes(k));
  if (hasManagementSignal) return null;

  return PROPOSAL_EXAMPLE;
}
