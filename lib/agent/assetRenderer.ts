import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// AlexAgent v0.2 — first vertical slice. Deterministic SVG composition
// rasterized by Sharp, with the real official logo PNG composited on
// top unmodified. No generative image model, no browser automation.
// Intentionally one small, fixed composition (not a layout engine):
// navy canvas, an amber accent bar, the logo, a word-wrapped headline,
// and a CTA pill. The only variation is a deterministic function of the
// asset version number (see THEMES below) — never random, never AI.

export const IMAGE_POST_WIDTH = 1080;
export const IMAGE_POST_HEIGHT = 1350;

const NAVY = "#0F172A";
const AMBER = "#F59E0B";
const WHITE = "#FFFFFF";

const MARGIN_X = 64;
const CONTENT_WIDTH = IMAGE_POST_WIDTH - MARGIN_X * 2;
const FONT_STACK = "Arial, Helvetica, sans-serif"; // see report: Inter is not guaranteed present server-side; BRAND.md/VISUAL_IDENTITY.md already tolerate "Inter or a similar sans-serif".

// Official logo asset used for compositing — chosen because its "Solar"
// wordmark renders in a light tone, making it the variant with correct
// contrast against this renderer's navy canvas (see VISUAL_IDENTITY.md
// section 3: filenames are not a reliable signal of intended background).
const LOGO_FILE = "brands/solardesk/assets/logos/logo.png";
const LOGO_WIDTH = 260;

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

export interface RenderAssetInput {
  headline: string;
  ctaText: string;
  assetVersion: number;
}

export interface RenderAssetResult {
  png: Buffer;
  width: number;
  height: number;
  provenance: Record<string, unknown>;
}

/**
 * Pure rendering function — no DB, no storage, no network. Given the
 * approved draft's own hook (headline) and CTA text, produces a
 * 1080x1350 branded PNG. Throws AssetRenderError (never returns a
 * partial/overflowing image) if the approved text cannot be fit safely
 * within the fixed layout even at the smallest allowed size.
 */
export async function renderImagePostAsset(input: RenderAssetInput): Promise<RenderAssetResult> {
  const theme = THEMES[themeForVersion(input.assetVersion)];

  const headlineWrap = wrapToFit(input.headline, [72, 64, 56, 48, 40], CONTENT_WIDTH, 4);
  if (!headlineWrap) {
    throw new AssetRenderError(
      "The approved headline is too long to render safely within the image layout without truncating or overflowing it."
    );
  }

  const ctaWrap = wrapToFit(input.ctaText, [32, 28, 24], CONTENT_WIDTH - 96, 1);
  if (!ctaWrap) {
    throw new AssetRenderError(
      "The approved CTA text is too long to render safely within a single-line CTA pill."
    );
  }
  const ctaLine = ctaWrap.lines[0];
  const ctaFontSize = ctaWrap.fontSize;
  const ctaPillWidth = Math.min(CONTENT_WIDTH, ctaLine.length * ctaFontSize * 0.58 + 96);
  const ctaPillHeight = ctaFontSize + 48;

  const lineHeight = headlineWrap.fontSize * 1.25;
  const headlineLinesSvg = headlineWrap.lines
    .map(
      (line, i) =>
        `<tspan x="${IMAGE_POST_WIDTH / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`
    )
    .join("");

  const accentBarSvg =
    theme.accentBarPosition === "top"
      ? `<rect x="0" y="0" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`
      : `<rect x="0" y="${IMAGE_POST_HEIGHT - 24}" width="${IMAGE_POST_WIDTH}" height="24" fill="${AMBER}" />`;

  const svg = `
    <svg width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${IMAGE_POST_WIDTH}" height="${IMAGE_POST_HEIGHT}" fill="${NAVY}" />
      ${accentBarSvg}
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${theme.headlineY}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${headlineWrap.fontSize}"
        fill="${WHITE}"
      >${headlineLinesSvg}</text>
      <rect
        x="${(IMAGE_POST_WIDTH - ctaPillWidth) / 2}"
        y="${theme.ctaY - ctaPillHeight / 2}"
        width="${ctaPillWidth}"
        height="${ctaPillHeight}"
        rx="${ctaPillHeight / 2}"
        fill="${AMBER}"
      />
      <text
        x="${IMAGE_POST_WIDTH / 2}"
        y="${theme.ctaY + ctaFontSize * 0.32}"
        text-anchor="middle"
        font-family="${FONT_STACK}"
        font-weight="bold"
        font-size="${ctaFontSize}"
        fill="${NAVY}"
      >${escapeXml(ctaLine)}</text>
    </svg>
  `;

  const backgroundPng = await sharp(Buffer.from(svg)).png().toBuffer();

  let logoBuffer: Buffer;
  try {
    const logoPath = path.join(process.cwd(), LOGO_FILE);
    const rawLogo = await readFile(logoPath);
    logoBuffer = await sharp(rawLogo).resize({ width: LOGO_WIDTH, fit: "inside" }).png().toBuffer();
  } catch (err) {
    throw new AssetRenderError(
      `Could not load the official SolarDesk logo asset (${LOGO_FILE}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const png = await sharp(backgroundPng)
    .composite([{ input: logoBuffer, top: theme.logoY, left: MARGIN_X }])
    .png()
    .toBuffer();

  return {
    png,
    width: IMAGE_POST_WIDTH,
    height: IMAGE_POST_HEIGHT,
    provenance: {
      renderer: "svg-sharp-v1",
      theme: themeForVersion(input.assetVersion),
      logoFile: LOGO_FILE,
      headline: { source: "draft.hook", fontSize: headlineWrap.fontSize, lines: headlineWrap.lines.length },
      cta: { source: "draft.cta_text", fontSize: ctaFontSize },
    },
  };
}
