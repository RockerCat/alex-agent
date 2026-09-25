import { readFile } from "node:fs/promises";
import path from "node:path";
import * as opentype from "opentype.js";

// Deterministic typography for the asset renderer (real production
// incident, 2026-09-25): SVG <text> rasterized by Sharp/librsvg depends
// on whatever fonts the host's fontconfig can find. The Vercel runtime
// has none, so every renderer-drawn character came out as a replacement
// box, while local macOS (CoreText + system Arial) rendered fine. This
// module removes the host-font dependency entirely: renderer-owned text
// is converted to SVG <path> outlines from a font bundled in the repo,
// so Sharp never has to resolve a font and local/Vercel execute the
// exact same code path.
//
// Liberation Sans (SIL OFL 1.1, see assets/fonts/liberation-sans/LICENSE)
// is metric-compatible with Arial — the renderer's previous requested
// font — so the renderer's existing wrapping/fit math stays valid.
//
// Kept as a local literal in the same module as the readFile call:
// Next's build-time file tracer only resolves a fs path as statically
// scoped when the directory literal is declared next to the fs call
// (same pattern as SCREENSHOT_DIR / PROPOSAL_RENDERED_DIR in
// lib/agent/assetRenderer.ts).
const FONT_DIR = "assets/fonts/liberation-sans";
const FONT_FILES = {
  regular: "LiberationSans-Regular.ttf",
  bold: "LiberationSans-Bold.ttf",
} as const;

export const BUNDLED_FONT_NAME = "Liberation Sans 2.1.5";

export type FontWeight = keyof typeof FONT_FILES;

export class TextOutlineError extends Error {}

const fontCache = new Map<FontWeight, Promise<opentype.Font>>();

async function loadFont(weight: FontWeight): Promise<opentype.Font> {
  const fontPath = path.join(process.cwd(), FONT_DIR, FONT_FILES[weight]);
  try {
    const bytes = await readFile(fontPath);
    return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (err) {
    throw new TextOutlineError(
      `Could not load the bundled renderer font (${FONT_DIR}/${FONT_FILES[weight]}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Loads (once per process) the bundled font for `weight`. A failed load is not cached, so a transient error can be retried. */
export function getBundledFont(weight: FontWeight): Promise<opentype.Font> {
  let cached = fontCache.get(weight);
  if (!cached) {
    cached = loadFont(weight);
    cached.catch(() => fontCache.delete(weight));
    fontCache.set(weight, cached);
  }
  return cached;
}

function formatCodePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Code points in `text` that the bundled font has no glyph for, as
 * "U+XXXX" labels (deduplicated, in order of first appearance). Iterates
 * by code point, so astral characters (emoji) are checked whole.
 */
export function findMissingGlyphs(font: opentype.Font, text: string): string[] {
  const missing: string[] = [];
  for (const char of text) {
    if (font.charToGlyphIndex(char) === 0) {
      const label = formatCodePoint(char);
      if (!missing.includes(label)) missing.push(label);
    }
  }
  return missing;
}

export interface OutlinedTextLine {
  text: string;
  /** Anchor x: the line's horizontal center ("middle", the default) or its right edge ("end"). */
  x: number;
  /** Baseline y, same meaning as SVG <text>'s `y`. */
  y: number;
}

export interface OutlinedTextOptions {
  /** Identifies the text in error messages (e.g. "headline") — never the text itself. */
  label: string;
  lines: OutlinedTextLine[];
  weight: FontWeight;
  fontSize: number;
  fill: string;
  fillOpacity?: number;
  /** Like SVG text-anchor: "middle" (default) centers each line on its x; "end" right-aligns it there. */
  anchor?: "middle" | "end";
}

/** Advance width of `text` in the bundled font — the same metric outlineText positions with. */
export async function measureText(text: string, weight: FontWeight, fontSize: number): Promise<number> {
  return (await getBundledFont(weight)).getAdvanceWidth(text, fontSize);
}

/**
 * Returns a single SVG <path> element drawing every line with the
 * bundled font's real glyph outlines, horizontally centered on each
 * line's `x` using the font's real advance widths (what SVG's
 * text-anchor="middle" does). Fails closed: throws TextOutlineError
 * naming only the missing code points if any character has no glyph in
 * the bundled font — never draws a replacement box or silently drops it.
 */
export async function outlineText(options: OutlinedTextOptions): Promise<string> {
  const font = await getBundledFont(options.weight);

  const missing = findMissingGlyphs(font, options.lines.map((line) => line.text).join(""));
  if (missing.length > 0) {
    throw new TextOutlineError(
      `The ${options.label} contains characters the bundled renderer font (${BUNDLED_FONT_NAME}) cannot draw: ${missing.join(", ")}.`
    );
  }

  const pathData = options.lines
    .map((line) => {
      const width = font.getAdvanceWidth(line.text, options.fontSize);
      const left = options.anchor === "end" ? line.x - width : line.x - width / 2;
      return font.getPath(line.text, left, line.y, options.fontSize).toPathData(2);
    })
    .join(" ");

  const opacity = options.fillOpacity !== undefined ? ` fill-opacity="${options.fillOpacity}"` : "";
  return `<path d="${pathData}" fill="${options.fill}"${opacity} />`;
}
