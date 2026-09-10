// Small, hand-verified catalog of the 9 real SolarDesk product
// screenshots (brands/solardesk/assets/product-screenshots/). This is
// deliberately NOT a general asset catalog, embeddings/RAG index, or a
// multimodal selector — just a fixed table describing what each
// screenshot visibly shows, verified by direct visual inspection, plus
// the one safe crop/mask each would need if ever used in a marketing
// composition. Never used to assert Product Truth — only to decide
// which real, existing screenshot (if any) is topically appropriate to
// place inside a rendered asset.
//
// References/ (Camp_01.png, portada.png) are intentionally absent from
// this catalog: those are historical/marketing mockups, not current
// product screenshots, and must never be selected here.

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotMeta {
  /** Filename under brands/solardesk/assets/product-screenshots/. */
  file: string;
  /** Concise, verified description of what is visibly shown — not a claim, just an observation. */
  visibleSubject: string;
  /** True only if this screenshot visibly shows the proposals list/management UI. */
  showsProposalManagement: boolean;
  /** True only if this screenshot visibly shows general dashboard/product-overview UI. */
  showsProductOverview: boolean;
  /**
   * Region(s), in this screenshot's own original pixel coordinates, that
   * must be covered with a solid mask before any marketing use — e.g. a
   * plan-limit/upsell banner. Empty if nothing in the safe crop region
   * needs masking.
   */
  maskRegions: PixelRect[];
  /**
   * The single region, in original pixel coordinates, considered safe
   * to use for marketing composition: recognizable UI chrome and
   * structure, without making a specific dollar amount or test client
   * name the dominant visual element.
   */
  safeCropRegion: PixelRect;
}

const PRODUCT_SCREENSHOTS: ScreenshotMeta[] = [
  {
    file: "01.png",
    visibleSubject: "Dashboard (Inicio): summary stat tiles and a 'Propuestas recientes' list.",
    showsProposalManagement: true,
    showsProductOverview: true,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "02.png",
    visibleSubject: "Clientes: client list table with status/action columns.",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "03.png",
    visibleSubject: "Nuevo cliente: client creation form.",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "04.png",
    visibleSubject:
      "Propuestas solares: the proposals list — page header, search/status-filter tabs, and a results table (Título/Cliente/Sistema/Valor estimado/Estado).",
    showsProposalManagement: true,
    showsProductOverview: false,
    // "Plan Gratis · 1 de 1 propuestas usadas este mes · Ver planes" —
    // a plan-limit/upgrade line. Pricing/promotion-adjacent, so it is
    // masked out before this screenshot is ever used, regardless of
    // the crop chosen.
    maskRegions: [{ x: 225, y: 140, width: 460, height: 24 }],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 460 },
  },
  {
    file: "05.png",
    visibleSubject: "Perfil de empresa: company profile settings form (name, contact, location).",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "06.png",
    visibleSubject: "Perfil de empresa (continued): default currency/IVA/margin settings for proposals.",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "07.png",
    visibleSubject: "Company logo upload, per-customer PDF color personalization, and proposal email template settings.",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "08.png",
    visibleSubject: "Seguridad: change-password form.",
    showsProposalManagement: false,
    showsProductOverview: false,
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
  {
    file: "09.png",
    visibleSubject: "Mi Suscripción: current plan and PRO upgrade/pricing panel.",
    showsProposalManagement: false,
    showsProductOverview: false,
    // Never selected for marketing composition (see selectProductScreenshot) —
    // its entire subject is plan pricing, not something to visually
    // repurpose into an unrelated marketing message.
    maskRegions: [],
    safeCropRegion: { x: 0, y: 0, width: 1439, height: 260 },
  },
];

const PROPOSAL_KEYWORDS = ["propuesta", "propuestas", "cotización", "cotizacion", "cotizaciones", "quote", "proposal"];
const PRODUCT_KEYWORDS = [
  "producto",
  "product",
  "plataforma",
  "platform",
  "interfaz",
  "interface",
  "pantalla",
  "screen",
  "dashboard",
  "mockup",
  "screenshot",
  "captura",
  "ui",
];

/**
 * Deterministic, keyword-based selection — not AI, not embeddings, not
 * a general layout planner. Only decides: does this brief's approved
 * visualDirection/purpose/topic call for real product UI, and if so,
 * which single verified screenshot best matches? Returns null when
 * nothing in the catalog is a safe, relevant match — callers must fall
 * back to the text-only composition rather than forcing an unrelated
 * screenshot in.
 */
export function selectProductScreenshot(input: {
  visualDirection: string;
  purpose: string;
  topic: string;
}): ScreenshotMeta | null {
  const text = `${input.visualDirection} ${input.purpose} ${input.topic}`.toLowerCase();

  const wantsProduct = PRODUCT_KEYWORDS.some((k) => text.includes(k)) || PROPOSAL_KEYWORDS.some((k) => text.includes(k));
  if (!wantsProduct) return null;

  const wantsProposal = PROPOSAL_KEYWORDS.some((k) => text.includes(k));
  if (wantsProposal) {
    return PRODUCT_SCREENSHOTS.find((s) => s.showsProposalManagement && s.file === "04.png") ?? null;
  }

  return PRODUCT_SCREENSHOTS.find((s) => s.showsProductOverview) ?? null;
}

export function getScreenshotMeta(file: string): ScreenshotMeta | undefined {
  return PRODUCT_SCREENSHOTS.find((s) => s.file === file);
}
