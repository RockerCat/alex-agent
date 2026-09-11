import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { selectProductScreenshot, type ScreenshotMeta } from "@/lib/agent/productScreenshots";
import { selectProposalExample, type ProposalExampleMeta } from "@/lib/agent/proposalExamples";
import { DEFAULT_RENDER_SPEC, type AssetRenderSpec, type VisualStrategy } from "@/lib/agent/schemas";

// AlexAgent v0.2 — first vertical slice. Deterministic SVG composition
// rasterized by Sharp, with the real official logo PNG composited on
// top unmodified. No generative image model, no browser automation.
// Three fixed compositions only (still not a general layout engine):
//   - text-only: navy canvas, accent bar, logo, headline, CTA pill.
//   - product: same brand chrome, but with a real verified SolarDesk
//     product screenshot framed as the primary visual element, chosen
//     by lib/agent/productScreenshots.ts from `visualDirection` /
//     `purpose` / `topic`. Never AI-selected, never generated pixels —
//     only real screenshot bytes, cropped/masked/resized/rounded.
//   - proposal: same brand chrome, but with the real verified
//     client-facing proposal example (a real PDF's rendered pages)
//     framed as the dominant visual, chosen by
//     lib/agent/proposalExamples.ts, with a subtle disclosure line
//     below it making clear the values shown are illustrative.
//     Takes precedence over the product composition when the brief
//     asks to show the actual proposal output rather than the
//     internal management screen.
// The only other variation is a deterministic function of the asset
// version number (see THEMES below) — never random, never AI.

export const IMAGE_POST_WIDTH = 1080;
export const IMAGE_POST_HEIGHT = 1350;

const NAVY = "#0F172A";
const AMBER = "#F59E0B";
const WHITE = "#FFFFFF";
const NEUTRAL = "#E5E7EB"; // verified in VISUAL_IDENTITY.md's confirmed palette

const MARGIN_X = 64;
const CONTENT_WIDTH = IMAGE_POST_WIDTH - MARGIN_X * 2; // 952
const FONT_STACK = "Arial, Helvetica, sans-serif"; // see report: Inter is not guaranteed present server-side; BRAND.md/VISUAL_IDENTITY.md already tolerate "Inter or a similar sans-serif".

// Official logo asset used for compositing — chosen because its "Solar"
// wordmark renders in a light tone, making it the variant with correct
// contrast against this renderer's navy canvas (see VISUAL_IDENTITY.md
// section 3: filenames are not a reliable signal of intended background).
const LOGO_FILE = "brands/solardesk/assets/logos/logo.png";
const LOGO_WIDTH = 260;

const SCREENSHOT_DIR = "brands/solardesk/assets/product-screenshots";
// Kept as a local literal (matching proposalExamples.ts's exported
// PROPOSAL_RENDERED_DIR, which must stay equal to this) rather than
// imported directly: Next's build-time file tracer can only resolve a
// fs path as statically scoped when the directory literal is declared
// in the same module as the fs call, same as SCREENSHOT_DIR above —
// an imported constant is treated as fully dynamic and triggers
// whole-project tracing.
const PROPOSAL_RENDERED_DIR = "brands/solardesk/assets/proposal-examples/rendered";

export class AssetRenderError extends Error {}

interface WrapResult {
  lines: string[];
  fontSize: number;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Deterministic word-wrap using a conservative average-character-width
 * heuristic (no real glyph shaping available before rendering). Always
 * wraps at word boundaries — never truncates or drops characters, so the
 * approved text is never silently altered. Tries decreasing font sizes
 * until the text fits within maxLines; returns null if even the
 * smallest size does not fit, so the caller can fail safely instead of
 * overflowing the canvas or cutting the message.
 */
function wrapToFit(text: string, candidateSizes: number[], maxWidthPx: number, maxLines: number): WrapResult | null {
  const words = text.trim().split(/\s+/);

  for (const fontSize of candidateSizes) {
    const avgCharWidth = fontSize * 0.58; // conservative for a bold sans-serif
    const maxCharsPerLine = Math.max(1, Math.floor(maxWidthPx / avgCharWidth));

    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxCharsPerLine || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);

    if (lines.length <= maxLines) {
      return { lines, fontSize };
    }
  }

  return null;
}

interface Theme {
  accentBarPosition: "top" | "bottom";
  headlineY: number;
  logoY: number;
  ctaY: number;
}

const THEMES: Record<"a" | "b", Theme> = {
  a: { accentBarPosition: "top", headlineY: 560, logoY: 96, ctaY: 1180 },
  b: { accentBarPosition: "bottom", headlineY: 620, logoY: 72, ctaY: 1120 },
};

function themeForVersion(assetVersion: number): "a" | "b" {
  return assetVersion % 2 === 1 ? "a" : "b";
}

// Fixed layout constants for the product-screenshot composition. Unlike
// THEMES above (tuned for a large centered headline over an otherwise
// empty canvas), these position a smaller headline above a framed
// screenshot "card" that becomes the primary visual element — only the
// accent bar position still alternates with asset version, via THEMES.
const PRODUCT_LOGO_Y = 64;
const PRODUCT_HEADLINE_TOP_Y = 260;
const PRODUCT_HEADLINE_SIZES = [52, 44, 38, 34];
const PRODUCT_HEADLINE_MAX_LINES = 3;
const PRODUCT_CARD_Y = 460;
const PRODUCT_CARD_WIDTH = CONTENT_WIDTH;
const PRODUCT_CARD_PADDING = 20;
const PRODUCT_CARD_RADIUS = 24;
const PRODUCT_CHROME_HEIGHT = 40;
const PRODUCT_CTA_Y = 1180;

// Fixed layout constants for the proposal-example composition: the
// real proposal page(s) become the dominant visual, with a smaller
// headline above, and a subtle disclosure line below the document
// stack (not a badge) making clear it is an illustrative example.
const PROPOSAL_LOGO_Y = 56;
const PROPOSAL_HEADLINE_TOP_Y = 230;
const PROPOSAL_HEADLINE_SIZES = [46, 40, 36, 32];
const PROPOSAL_HEADLINE_MAX_LINES = 2;
const PROPOSAL_STACK_TOP_Y = 330;
const PROPOSAL_STACK_BOTTOM_MAX_Y = 1150;
const PROPOSAL_PAGE_OFFSET = 76; // how far page 2 peeks out behind/below page 1
const PROPOSAL_FRAME_MARGIN = 10; // white "mat" border drawn around each page
const PROPOSAL_FRAME_RADIUS = 20;
const PROPOSAL_PAGE_RADIUS = 12;
const PROPOSAL_DISCLOSURE_GAP = 34; // gap between the stack's outer frame and the disclosure line
const PROPOSAL_DISCLOSURE_FONT_SIZE = 24;
const PROPOSAL_DISCLOSURE_TEXT = "Propuesta de ejemplo · Valores ilustrativos";
const PROPOSAL_CTA_Y = 1250;

// Bounded, renderer-owned presets for AssetRenderSpec (lib/agent/schemas.ts).
// The AI feedback interpreter only ever picks one of the enum keys on
// the left — every actual pixel/scale value here is a fixed constant
// it never sees or controls. "normal" on every field reproduces
// today's layout exactly (same numbers as the constants above).
const PRODUCT_PRIMARY_VISUAL_SCALE: Record<AssetRenderSpec["primaryVisualScale"], number> = {
  normal: 1.0,
  large: 1.08,
  dominant: 1.16,
};
// The proposal stack's height is already tightly budgeted against the
// fixed disclosure line and CTA below it, so growth there comes from
// reclaiming a few pixels of the headline gap rather than a
// width/height multiplier (which risks colliding with the disclosure
// line or CTA — see prepareProposalStack).
const PROPOSAL_STACK_TOP_Y_BY_SCALE: Record<AssetRenderSpec["primaryVisualScale"], number> = {
  normal: PROPOSAL_STACK_TOP_Y,
  large: 318,
  dominant: 308,
};
const CTA_EMPHASIS_FONT_SIZES: Record<AssetRenderSpec["ctaEmphasis"], number[]> = {
  subtle: [22, 20, 18],
  normal: [32, 28, 24],
  strong: [40, 36, 32],
};
const CTA_EMPHASIS_PADDING_SCALE: Record<AssetRenderSpec["ctaEmphasis"], number> = {
  subtle: 0.85,
  normal: 1.0,
  strong: 1.15,
};
const LOGO_EMPHASIS_SCALE: Record<AssetRenderSpec["logoEmphasis"], number> = {
  subtle: 0.8,
  normal: 1.0,
  strong: 1.25,
};
const SECONDARY_PAGE_OFFSET_BY_VISIBILITY: Record<AssetRenderSpec["secondaryPageVisibility"], number> = {
  hidden: 0,
  subtle: 40,
  normal: PROPOSAL_PAGE_OFFSET,
};
const DISCLOSURE_PRESETS: Record<AssetRenderSpec["disclosureEmphasis"], { fontSize: number; opacity: number }> = {
  subtle: { fontSize: 20, opacity: 0.48 },
  normal: { fontSize: PROPOSAL_DISCLOSURE_FONT_SIZE, opacity: 0.62 },
};

// Layout constants for the hero composition (generated_photo /
// generated_illustration / hybrid strategies — Visual Director,
// AlexAgent v0.2). A generated supporting image fills the canvas;
// a bottom scrim gradient (always drawn, regardless of the photo's own
// content — this is what actually guarantees text legibility, not a
// request to the generative model) carries the headline/CTA; the logo
// gets its own small solid-navy backing chip so contrast is guaranteed
// regardless of what's behind it. hybrid additionally insets one real
// verified card (product screenshot or a single proposal page) in the
// clean space between the logo and the scrim.
const HERO_LOGO_Y = 56;
const HERO_LOGO_CHIP_PADDING = 18;
const HERO_LOGO_CHIP_RADIUS = 16;
const HERO_SCRIM_TOP_RATIO = 0.56; // fraction of canvas height where the scrim gradient begins
const HERO_HEADLINE_TOP_Y = 1000;
const HERO_HEADLINE_SIZES = [56, 48, 42, 36, 30];
const HERO_HEADLINE_MAX_LINES = 3;
const HERO_CTA_Y = 1250;
const HERO_CARD_TOP_Y = 380;
const HERO_CARD_WIDTH = Math.round(CONTENT_WIDTH * 0.82);
const HERO_CARD_RADIUS = 20;

export interface RenderAssetInput {
  headline: string;
  ctaText: string;
  assetVersion: number;
  /** Approved draft fields used only to decide whether a real product screenshot belongs in the composition — never used as literal layout instructions. Ignored for source selection when `strategy`/`forceScreenshotMeta`/`forceProposalMeta` are explicitly provided (Visual Director path); still used for headline/CTA text wrapping regardless. */
  visualDirection?: string;
  purpose?: string;
  topic?: string;
  /** Bounded composition adjustments (see lib/agent/schemas.ts). Defaults to DEFAULT_RENDER_SPEC, which reproduces the original fixed layout exactly. */
  renderSpec?: AssetRenderSpec;
  /**
   * Visual Director integration (AlexAgent v0.2 — all fields below are
   * optional and additive; omitting all of them reproduces today's
   * exact keyword-driven selection byte-for-byte, so every existing
   * caller/test is unaffected). When `strategy` is one of the
   * generative strategies, this function delegates to a separate hero
   * composition path driven by `generatedImage` rather than the
   * existing product/proposal/text-only branches below. When `strategy`
   * is "branded_graphic", source selection is skipped entirely (forced
   * text-only) even if visualDirection/purpose/topic would otherwise
   * keyword-match a screenshot/proposal. When `forceScreenshotMeta` /
   * `forceProposalMeta` are explicitly passed (including explicitly
   * `null`, meaning "resolved to nothing"), they are used in place of
   * this function's own selectProductScreenshot/selectProposalExample
   * calls — the caller (a Visual-Director-resolved plan) has already
   * decided which real catalog entry (if any) applies.
   */
  strategy?: VisualStrategy;
  forceScreenshotMeta?: ScreenshotMeta | null;
  forceProposalMeta?: ProposalExampleMeta | null;
  /** Resolved generated image bytes for generated_photo/generated_illustration/hybrid strategies. Required (non-null) for those strategies — never fabricated by this function if absent (throws AssetRenderError instead). */
  generatedImage?: Buffer | null;
}

export interface RenderAssetResult {
  png: Buffer;
  width: number;
  height: number;
  provenance: Record<string, unknown>;
}

async function loadLogoBuffer(width: number): Promise<Buffer> {
  try {
    const logoPath = path.join(process.cwd(), LOGO_FILE);
    const rawLogo = await readFile(logoPath);
    return await sharp(rawLogo).resize({ width, fit: "inside" }).png().toBuffer();
  } catch (err) {
    throw new AssetRenderError(
      `Could not load the official SolarDesk logo asset (${LOGO_FILE}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Loads the real screenshot named by `meta`, applies only the allowed
 * evidence-safe operations (crop to the verified safe region, mask any
 * pricing/plan-limit region, resize, round corners) and returns it
 * ready to composite. Never redraws or alters pixels inside the safe
 * region itself — only covers regions the catalog explicitly flags.
 * Any failure here is the caller's signal to fall back to the
 * text-only composition rather than fabricating UI.
 */
async function prepareScreenshotCard(meta: ScreenshotMeta, displayWidth: number, radius: number): Promise<{ buffer: Buffer; height: number }> {
  const filePath = path.join(process.cwd(), SCREENSHOT_DIR, meta.file);
  const raw = await readFile(filePath);

  const crop = meta.safeCropRegion;
  let croppedBuffer = await sharp(raw)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .png()
    .toBuffer();

  const maskOverlays = meta.maskRegions
    .map((mask) => ({
      input: { create: { width: mask.width, height: mask.height, channels: 4 as const, background: WHITE } },
      left: mask.x - crop.x,
      top: mask.y - crop.y,
    }))
    .filter((overlay) => overlay.left >= 0 && overlay.top >= 0);

  if (maskOverlays.length > 0) {
    // Materialize the masked result to its own buffer before any later
    // resize: sharp applies a queued resize() to the base image ahead
    // of a queued composite() regardless of call order, so chaining
    // resize directly onto this same pipeline would scale the
    // screenshot while leaving the mask at its original, now-wrong,
    // unscaled position.
    croppedBuffer = await sharp(croppedBuffer).composite(maskOverlays).png().toBuffer();
  }

  const displayHeight = Math.round((displayWidth / crop.width) * crop.height);
  const resized = await sharp(croppedBuffer)
    .resize({ width: displayWidth, height: displayHeight, fit: "cover" })
    .png()
    .toBuffer();

  const roundedMaskSvg = `<svg width="${displayWidth}" height="${displayHeight}"><rect x="0" y="0" width="${displayWidth}" height="${displayHeight}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`;
  const rounded = await sharp(resized)
    .composite([{ input: Buffer.from(roundedMaskSvg), blend: "dest-in" }])
    .png()
    .toBuffer();

  return { buffer: rounded, height: displayHeight };
}

interface PageCard {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Loads a direct raster derivative of a real PDF proposal page and
 * rounds its corners for framing. Never redraws, retypesets, or alters
 * pixels inside the page — only resizes (preserving aspect ratio) and
 * rounds corners, the same allowed evidence-safe operations used for
 * product screenshots.
 */
async function preparePageCard(pageFile: string, displayWidth: number, radius: number, cropHeight?: number): Promise<PageCard> {
  const filePath = path.join(process.cwd(), PROPOSAL_RENDERED_DIR, pageFile);
  const raw = await readFile(filePath);
  const meta = await sharp(raw).metadata();
  if (!meta.width || !meta.height) {
    throw new AssetRenderError(`Could not read dimensions for proposal page asset: ${pageFile}`);
  }

  const sourceHeight = cropHeight && cropHeight > 0 && cropHeight <= meta.height ? cropHeight : meta.height;
  const source =
    sourceHeight === meta.height
      ? raw
      : await sharp(raw).extract({ left: 0, top: 0, width: meta.width, height: sourceHeight }).png().toBuffer();

  const displayHeight = Math.round((displayWidth / meta.width) * sourceHeight);
  const resized = await sharp(source).resize({ width: displayWidth, height: displayHeight, fit: "cover" }).png().toBuffer();

  const roundedMaskSvg = `<svg width="${displayWidth}" height="${displayHeight}"><rect x="0" y="0" width="${displayWidth}" height="${displayHeight}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`;
  const rounded = await sharp(resized)
    .composite([{ input: Buffer.from(roundedMaskSvg), blend: "dest-in" }])
    .png()
    .toBuffer();

  return { buffer: rounded, width: displayWidth, height: displayHeight };
}

interface ProposalStack {
  page1: PageCard;
  page2: PageCard | null;
  page1X: number;
  page1Y: number;
  page2X: number;
  page2Y: number;
}

/**
 * Prepares the two real proposal pages as a "stacked documents" visual:
 * page 1 dominant and fully visible, page 2 behind it offset down and
 * to the right so only its edges peek out (or omitted entirely when
 * `spec.secondaryPageVisibility` is "hidden"). Any failure here
 * (missing derivative file, unreadable dimensions) is the caller's
 * signal to fall back safely rather than fabricating a proposal.
 */
async function prepareProposalStack(meta: ProposalExampleMeta, spec: AssetRenderSpec): Promise<ProposalStack> {
  const [page1Meta, page2Meta] = meta.pages;

  const stackTopY = PROPOSAL_STACK_TOP_Y_BY_SCALE[spec.primaryVisualScale];
  const pageOffset = SECONDARY_PAGE_OFFSET_BY_VISIBILITY[spec.secondaryPageVisibility];
  const showSecondaryPage = spec.secondaryPageVisibility !== "hidden";

  const availableHeight = PROPOSAL_STACK_BOTTOM_MAX_Y - stackTopY - pageOffset;
  const page1Raw = await readFile(path.join(process.cwd(), PROPOSAL_RENDERED_DIR, page1Meta.file));
  const page1RawMeta = await sharp(page1Raw).metadata();
  if (!page1RawMeta.width || !page1RawMeta.height) {
    throw new AssetRenderError(`Could not read dimensions for proposal page asset: ${page1Meta.file}`);
  }
  const page1ContentHeight =
    page1Meta.contentHeight > 0 && page1Meta.contentHeight <= page1RawMeta.height ? page1Meta.contentHeight : page1RawMeta.height;
  const aspect = page1ContentHeight / page1RawMeta.width;
  const page1Width = Math.round(availableHeight / aspect);

  const page1 = await preparePageCard(page1Meta.file, page1Width, PROPOSAL_PAGE_RADIUS, page1ContentHeight);
  // Page 2 is only a "peek" behind page 1 (see prepareProposalStack's
  // doc comment) — it is cropped to the same box proportions as page 1
  // (rather than its own full contentHeight) purely so the stack reads
  // as two same-size documents, not because more of page 2 would be
  // unsafe to show.
  const page2 = showSecondaryPage ? await preparePageCard(page2Meta.file, page1Width, PROPOSAL_PAGE_RADIUS, page1ContentHeight) : null;

  const stackWidth = page1.width + pageOffset;
  const stackLeft = Math.round((IMAGE_POST_WIDTH - stackWidth) / 2);

  return {
    page1,
    page2,
    page1X: stackLeft,
    page1Y: stackTopY,
    page2X: stackLeft + pageOffset,
    page2Y: stackTopY + pageOffset,
  };
}

/**
 * Pure rendering function — no DB, no storage, no network. Given the
 * approved draft's own hook (headline) and CTA text, produces a
 * 1080x1350 branded PNG. Throws AssetRenderError (never returns a
 * partial/overflowing image) if the approved text cannot be fit safely
 * within the fixed layout even at the smallest allowed size.
 *
 * When visualDirection/purpose/topic indicate product/proposal imagery
 * (see lib/agent/productScreenshots.ts), a verified real SolarDesk
 * screenshot is framed into the composition as the primary visual
 * element. If no screenshot is appropriate, or the selected screenshot
 * cannot be safely loaded, the original text-only composition is used
 * unchanged — this function never fabricates a screenshot.
 */
export async function renderImagePostAsset(input: RenderAssetInput): Promise<RenderAssetResult> {
  const theme = THEMES[themeForVersion(input.assetVersion)];
  const spec = input.renderSpec ?? DEFAULT_RENDER_SPEC;

  const selectionInput = {
    visualDirection: input.visualDirection ?? "",
    purpose: input.purpose ?? "",
    topic: input.topic ?? "",
  };

  if (input.strategy === "generated_photo" || input.strategy === "generated_illustration" || input.strategy === "hybrid") {
    return renderHeroComposition(input, theme, spec);
  }
  const forceBrandedGraphic = input.strategy === "branded_graphic";

  // Proposal-example takes precedence over the internal product
  // screenshot when the brief clearly asks to show the actual
  // client-facing proposal/output (see proposalExamples.ts) — only
  // falls through to the screenshot catalog when no proposal example
  // is selected, or the selected one cannot be safely prepared.
  // A Visual-Director-resolved plan may instead force the exact
  // catalog entry (or force nothing, for branded_graphic) via
  // forceProposalMeta — see RenderAssetInput's doc comment.
  const proposalMeta = forceBrandedGraphic
    ? null
    : input.forceProposalMeta !== undefined
      ? input.forceProposalMeta
      : selectProposalExample(selectionInput);
  let proposalStack: ProposalStack | null = null;
  if (proposalMeta) {
    try {
      proposalStack = await prepareProposalStack(proposalMeta, spec);
    } catch {
      // Fail safely: never fabricate a proposal. Fall back to the screenshot/text-only path.
      proposalStack = null;
    }
  }
  const usesProposalLayout = proposalStack !== null;

  // primaryVisualScale scales the whole card (not just its inner
  // display area), clamped so it can never approach the canvas edges
  // regardless of how large the requested scale is.
  const productCardWidth = Math.min(
    IMAGE_POST_WIDTH - 48,
    Math.round(PRODUCT_CARD_WIDTH * PRODUCT_PRIMARY_VISUAL_SCALE[spec.primaryVisualScale])
  );
  const productCardX = Math.round((IMAGE_POST_WIDTH - productCardWidth) / 2);

  let screenshotMeta: ScreenshotMeta | null = null;
  let screenshotCard: { buffer: Buffer; height: number } | null = null;
  if (!usesProposalLayout && !forceBrandedGraphic) {
    screenshotMeta = input.forceScreenshotMeta !== undefined ? input.forceScreenshotMeta : selectProductScreenshot(selectionInput);
    if (screenshotMeta) {
      try {
        const displayWidth = productCardWidth - PRODUCT_CARD_PADDING * 2;
        screenshotCard = await prepareScreenshotCard(screenshotMeta, displayWidth, PRODUCT_CARD_RADIUS - PRODUCT_CARD_PADDING / 2);
      } catch {
        // Fail safely: never fabricate UI. Fall back to the text-only composition.
        screenshotCard = null;
      }
    }
  }

  const usesProductLayout = screenshotCard !== null;

  const headlineWrap = usesProposalLayout
    ? wrapToFit(input.headline, PROPOSAL_HEADLINE_SIZES, CONTENT_WIDTH, PROPOSAL_HEADLINE_MAX_LINES)
    : usesProductLayout
      ? wrapToFit(input.headline, PRODUCT_HEADLINE_SIZES, CONTENT_WIDTH, PRODUCT_HEADLINE_MAX_LINES)
      : wrapToFit(input.headline, [72, 64, 56, 48, 40], CONTENT_WIDTH, 4);
  if (!headlineWrap) {
    throw new AssetRenderError(
      "The approved headline is too long to render safely within the image layout without truncating or overflowing it."
    );
  }

  const ctaPaddingScale = CTA_EMPHASIS_PADDING_SCALE[spec.ctaEmphasis];
  const ctaWrap = wrapToFit(input.ctaText, CTA_EMPHASIS_FONT_SIZES[spec.ctaEmphasis], CONTENT_WIDTH - 96, 1);
  if (!ctaWrap) {
    throw new AssetRenderError(
      "The approved CTA text is too long to render safely within a single-line CTA pill."
    );
  }
  const ctaLine = ctaWrap.lines[0];
  const ctaFontSize = ctaWrap.fontSize;
  const ctaPillWidth = Math.min(CONTENT_WIDTH, ctaLine.length * ctaFontSize * 0.58 + 96 * ctaPaddingScale);
  const ctaPillHeight = ctaFontSize + 48 * ctaPaddingScale;

  const accentBarSvg =
    theme.accentBarPosition === "top"
      ? `<rect x="0" y="0" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`
      : `<rect x="0" y="${IMAGE_POST_HEIGHT - 24}" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`;

  const headlineY = usesProposalLayout ? PROPOSAL_HEADLINE_TOP_Y : usesProductLayout ? PRODUCT_HEADLINE_TOP_Y : theme.headlineY;
  const ctaY = usesProposalLayout ? PROPOSAL_CTA_Y : usesProductLayout ? PRODUCT_CTA_Y : theme.ctaY;
  const logoY = usesProposalLayout ? PROPOSAL_LOGO_Y : usesProductLayout ? PRODUCT_LOGO_Y : theme.logoY;

  const lineHeight = headlineWrap.fontSize * 1.25;
  const headlineLinesSvg = headlineWrap.lines
    .map(
      (line, i) =>
        `<tspan x="${IMAGE_POST_WIDTH / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`
    )
    .join("");

  let cardSvg = "";
  let screenshotTop = 0;
  let screenshotLeft = 0;
  if (usesProductLayout && screenshotCard) {
    const cardHeight = PRODUCT_CHROME_HEIGHT + screenshotCard.height + PRODUCT_CARD_PADDING;
    screenshotLeft = productCardX + PRODUCT_CARD_PADDING;
    screenshotTop = PRODUCT_CARD_Y + PRODUCT_CHROME_HEIGHT;
    const dotCy = PRODUCT_CARD_Y + PRODUCT_CHROME_HEIGHT / 2;
    cardSvg = `
      <rect x="${productCardX}" y="${PRODUCT_CARD_Y}" width="${productCardWidth}" height="${cardHeight}" rx="${PRODUCT_CARD_RADIUS}" fill="${WHITE}" stroke="${NEUTRAL}" stroke-width="2" />
      <rect x="${productCardX}" y="${PRODUCT_CARD_Y}" width="${productCardWidth}" height="${PRODUCT_CHROME_HEIGHT}" rx="${PRODUCT_CARD_RADIUS}" fill="${NEUTRAL}" />
      <circle cx="${productCardX + 24}" cy="${dotCy}" r="6" fill="${AMBER}" />
      <circle cx="${productCardX + 44}" cy="${dotCy}" r="6" fill="${NAVY}" />
      <circle cx="${productCardX + 64}" cy="${dotCy}" r="6" fill="${WHITE}" />
    `;
  }

  let proposalSvg = "";
  let disclosureSvg = "";
  if (usesProposalLayout && proposalStack) {
    const { page1, page2, page1X, page1Y, page2X, page2Y } = proposalStack;
    const m = PROPOSAL_FRAME_MARGIN;
    // Shadow (offset dark rect), white "mat" frame, then the real page
    // image is composited on top afterward — page 2 drawn first so it
    // peeks out from behind page 1. page2 is null when
    // secondaryPageVisibility is "hidden" — only page 1's frame is drawn.
    const page2FrameSvg = page2
      ? `
      <rect x="${page2X - m + 6}" y="${page2Y - m + 8}" width="${page2.width + m * 2}" height="${page2.height + m * 2}" rx="${PROPOSAL_FRAME_RADIUS}" fill="${NAVY}" opacity="0.18" />
      <rect x="${page2X - m}" y="${page2Y - m}" width="${page2.width + m * 2}" height="${page2.height + m * 2}" rx="${PROPOSAL_FRAME_RADIUS}" fill="${WHITE}" />
      `
      : "";
    proposalSvg = `
      ${page2FrameSvg}
      <rect x="${page1X - m + 6}" y="${page1Y - m + 8}" width="${page1.width + m * 2}" height="${page1.height + m * 2}" rx="${PROPOSAL_FRAME_RADIUS}" fill="${NAVY}" opacity="0.22" />
      <rect x="${page1X - m}" y="${page1Y - m}" width="${page1.width + m * 2}" height="${page1.height + m * 2}" rx="${PROPOSAL_FRAME_RADIUS}" fill="${WHITE}" />
    `;

    // Subtle supporting text (not a badge/pill) directly below the
    // document stack's own frame — muted so it reads as a small print
    // disclosure belonging to the proposal, not a warning interrupting
    // the headline -> proposal -> CTA hierarchy.
    const stackOuterBottom = page2 ? page2Y + page2.height + m : page1Y + page1.height + m;
    const disclosurePreset = DISCLOSURE_PRESETS[spec.disclosureEmphasis];
    const disclosureY = stackOuterBottom + PROPOSAL_DISCLOSURE_GAP;
    disclosureSvg = `
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${disclosureY}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="normal"
        font-size="${disclosurePreset.fontSize}"
        fill="${WHITE}"
        fill-opacity="${disclosurePreset.opacity}"
      >${escapeXml(PROPOSAL_DISCLOSURE_TEXT)}</text>
    `;
  }

  const svg = `
    <svg width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT}" fill="${NAVY}" />
      ${accentBarSvg}
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${headlineY}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${headlineWrap.fontSize}"
        fill="${WHITE}"
      >${headlineLinesSvg}</text>
      ${cardSvg}
      ${proposalSvg}
      ${disclosureSvg}
      <rect
        x="${(IMAGE_POST_WIDTH - ctaPillWidth) / 2}"
        y="${ctaY - ctaPillHeight / 2}"
        width="${ctaPillWidth}"
        height="${ctaPillHeight}"
        rx="${ctaPillHeight / 2}"
        fill="${AMBER}"
      />
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${ctaY + ctaFontSize * 0.32}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${ctaFontSize}"
        fill="${NAVY}"
      >${escapeXml(ctaLine)}</text>
    </svg>
  `;

  const backgroundPng = await sharp(Buffer.from(svg)).png().toBuffer();
  const logoWidth = Math.round(LOGO_WIDTH * LOGO_EMPHASIS_SCALE[spec.logoEmphasis]);
  const logoBuffer = await loadLogoBuffer(logoWidth);

  const composites: Array<{ input: Buffer; top: number; left: number }> = [{ input: logoBuffer, top: logoY, left: MARGIN_X }];
  if (usesProductLayout && screenshotCard) {
    composites.push({ input: screenshotCard.buffer, top: screenshotTop, left: screenshotLeft });
  }
  if (usesProposalLayout && proposalStack) {
    if (proposalStack.page2) {
      composites.push({ input: proposalStack.page2.buffer, top: proposalStack.page2Y, left: proposalStack.page2X });
    }
    composites.push({ input: proposalStack.page1.buffer, top: proposalStack.page1Y, left: proposalStack.page1X });
  }

  const png = await sharp(backgroundPng).composite(composites).png().toBuffer();

  return {
    png,
    width: IMAGE_POST_WIDTH,
    height: IMAGE_POST_HEIGHT,
    provenance: {
      renderer: usesProposalLayout ? "svg-sharp-proposal-v1" : usesProductLayout ? "svg-sharp-product-v1" : "svg-sharp-v1",
      theme: themeForVersion(input.assetVersion),
      renderSpec: spec,
      logoFile: LOGO_FILE,
      headline: { source: "draft.hook", fontSize: headlineWrap.fontSize, lines: headlineWrap.lines.length },
      cta: { source: "draft.cta_text", fontSize: ctaFontSize },
      screenshot: screenshotMeta
        ? {
            selected: usesProductLayout,
            file: screenshotMeta.file,
            visibleSubject: screenshotMeta.visibleSubject,
            source: SCREENSHOT_DIR,
          }
        : { selected: false },
      proposalExample: proposalMeta
        ? {
            selected: usesProposalLayout,
            pdfPath: proposalMeta.pdfPath,
            pages: proposalMeta.pages.map((p) => `${PROPOSAL_RENDERED_DIR}/${p.file}`),
            disclosureText: PROPOSAL_DISCLOSURE_TEXT,
          }
        : { selected: false },
    },
  };
}

/**
 * Hero composition: a generated supporting image (see
 * lib/agent/imageGenerationClient.ts) fills the canvas; brand chrome
 * (logo, headline, CTA) is composited on top over a deterministic scrim
 * gradient that guarantees legibility regardless of the photo's own
 * content — the gradient is drawn by this renderer unconditionally, not
 * requested/hoped-for from the generative model. For the "hybrid"
 * strategy, one real verified source (a product screenshot or a single
 * proposal page — never generated) is additionally inset in the clean
 * space between the logo and the scrim. Never called with a null
 * `generatedImage` by any resolved caller; still fails loudly rather
 * than fabricating one if that ever happens.
 */
async function renderHeroComposition(
  input: RenderAssetInput,
  theme: Theme,
  spec: AssetRenderSpec
): Promise<RenderAssetResult> {
  if (!input.generatedImage) {
    throw new AssetRenderError("Hero composition requires a resolved generated image, but none was provided.");
  }

  const headlineWrap = wrapToFit(input.headline, HERO_HEADLINE_SIZES, CONTENT_WIDTH, HERO_HEADLINE_MAX_LINES);
  if (!headlineWrap) {
    throw new AssetRenderError(
      "The approved headline is too long to render safely within the image layout without truncating or overflowing it."
    );
  }
  const ctaPaddingScale = CTA_EMPHASIS_PADDING_SCALE[spec.ctaEmphasis];
  const ctaWrap = wrapToFit(input.ctaText, CTA_EMPHASIS_FONT_SIZES[spec.ctaEmphasis], CONTENT_WIDTH - 96, 1);
  if (!ctaWrap) {
    throw new AssetRenderError("The approved CTA text is too long to render safely within a single-line CTA pill.");
  }
  const ctaLine = ctaWrap.lines[0];
  const ctaFontSize = ctaWrap.fontSize;
  const ctaPillWidth = Math.min(CONTENT_WIDTH, ctaLine.length * ctaFontSize * 0.58 + 96 * ctaPaddingScale);
  const ctaPillHeight = ctaFontSize + 48 * ctaPaddingScale;

  const screenshotMeta = input.strategy === "hybrid" ? (input.forceScreenshotMeta ?? null) : null;
  const proposalMeta = input.strategy === "hybrid" && !screenshotMeta ? (input.forceProposalMeta ?? null) : null;

  let insetCard: { buffer: Buffer; width: number; height: number } | null = null;
  if (screenshotMeta) {
    try {
      const displayWidth = HERO_CARD_WIDTH - PRODUCT_CARD_PADDING * 2;
      const card = await prepareScreenshotCard(screenshotMeta, displayWidth, HERO_CARD_RADIUS - PRODUCT_CARD_PADDING / 2);
      insetCard = { buffer: card.buffer, width: displayWidth, height: card.height };
    } catch {
      insetCard = null; // Fail safely: never fabricate UI.
    }
  } else if (proposalMeta) {
    try {
      const [page1Meta] = proposalMeta.pages;
      insetCard = await preparePageCard(page1Meta.file, HERO_CARD_WIDTH, HERO_CARD_RADIUS, page1Meta.contentHeight);
    } catch {
      insetCard = null; // Fail safely: never fabricate a proposal.
    }
  }
  const showsProposalDisclosure = insetCard !== null && proposalMeta !== null;

  const accentBarSvg =
    theme.accentBarPosition === "top"
      ? `<rect x="0" y="0" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`
      : `<rect x="0" y="${IMAGE_POST_HEIGHT - 24}" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`;

  const scrimTopY = Math.round(IMAGE_POST_HEIGHT * HERO_SCRIM_TOP_RATIO);
  const lineHeight = headlineWrap.fontSize * 1.25;
  const headlineLinesSvg = headlineWrap.lines
    .map((line, i) => `<tspan x="${IMAGE_POST_WIDTH / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const disclosurePreset = DISCLOSURE_PRESETS[spec.disclosureEmphasis];
  const disclosureSvg = showsProposalDisclosure
    ? `
    <text
      x="${IMAGE_POST_WIDTH / 2}"
      y="${HERO_HEADLINE_TOP_Y - 40}"
      text-anchor="middle"
      font-family="${FONT_STACK}"
      font-weight="normal"
      font-size="${disclosurePreset.fontSize}"
      fill="${WHITE}"
      fill-opacity="${disclosurePreset.opacity}"
    >${escapeXml(PROPOSAL_DISCLOSURE_TEXT)}</text>
    `
    : "";

  const logoWidth = Math.round(LOGO_WIDTH * LOGO_EMPHASIS_SCALE[spec.logoEmphasis]);
  const logoChipWidth = logoWidth + HERO_LOGO_CHIP_PADDING * 2;
  const logoChipHeight = Math.round(logoWidth * 0.36) + HERO_LOGO_CHIP_PADDING * 2; // approximates the real logo file's aspect ratio with headroom

  // Transparent background (no navy fill rect, unlike the other
  // compositions) — this overlay is composited ON TOP of the generated
  // photo, not used as the base canvas itself.
  const overlaySvg = `
    <svg width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="heroScrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${NAVY}" stop-opacity="0" />
          <stop offset="100%" stop-color="${NAVY}" stop-opacity="0.86" />
        </linearGradient>
      </defs>
      ${accentBarSvg}
      <rect x="0" y="${scrimTopY}" width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT - scrimTopY}" fill="url(#heroScrim)" />
      <rect x="${MARGIN_X - HERO_LOGO_CHIP_PADDING}" y="${HERO_LOGO_Y - HERO_LOGO_CHIP_PADDING}" width="${logoChipWidth}" height="${logoChipHeight}" rx="${HERO_LOGO_CHIP_RADIUS}" fill="${NAVY}" fill-opacity="0.72" />
      ${disclosureSvg}
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${HERO_HEADLINE_TOP_Y}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${headlineWrap.fontSize}"
        fill="${WHITE}"
      >${headlineLinesSvg}</text>
      <rect
        x="${(IMAGE_POST_WIDTH - ctaPillWidth) / 2}"
        y="${HERO_CTA_Y - ctaPillHeight / 2}"
        width="${ctaPillWidth}"
        height="${ctaPillHeight}"
        rx="${ctaPillHeight / 2}"
        fill="${AMBER}"
      />
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${HERO_CTA_Y + ctaFontSize * 0.32}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${ctaFontSize}"
        fill="${NAVY}"
      >${escapeXml(ctaLine)}</text>
    </svg>
  `;

  const heroBackground = await sharp(input.generatedImage)
    .resize({ width: IMAGE_POST_WIDTH, height: IMAGE_POST_HEIGHT, fit: "cover" })
    .png()
    .toBuffer();
  const overlayPng = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
  const logoBuffer = await loadLogoBuffer(logoWidth);

  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: overlayPng, top: 0, left: 0 },
    { input: logoBuffer, top: HERO_LOGO_Y, left: MARGIN_X },
  ];
  if (insetCard) {
    const cardX = Math.round((IMAGE_POST_WIDTH - insetCard.width) / 2);
    composites.push({ input: insetCard.buffer, top: HERO_CARD_TOP_Y, left: cardX });
  }

  const png = await sharp(heroBackground).composite(composites).png().toBuffer();

  return {
    png,
    width: IMAGE_POST_WIDTH,
    height: IMAGE_POST_HEIGHT,
    provenance: {
      renderer: "svg-sharp-hero-v1",
      theme: themeForVersion(input.assetVersion),
      renderSpec: spec,
      logoFile: LOGO_FILE,
      headline: { source: "draft.hook", fontSize: headlineWrap.fontSize, lines: headlineWrap.lines.length },
      cta: { source: "draft.cta_text", fontSize: ctaFontSize },
      screenshot: screenshotMeta
        ? { selected: insetCard !== null, file: screenshotMeta.file, visibleSubject: screenshotMeta.visibleSubject, source: SCREENSHOT_DIR }
        : { selected: false },
      proposalExample: proposalMeta
        ? {
            selected: insetCard !== null,
            pdfPath: proposalMeta.pdfPath,
            pages: [`${PROPOSAL_RENDERED_DIR}/${proposalMeta.pages[0].file}`],
            disclosureText: PROPOSAL_DISCLOSURE_TEXT,
          }
        : { selected: false },
    },
  };
}
