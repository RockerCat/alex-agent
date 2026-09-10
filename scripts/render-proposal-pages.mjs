// One-off, single-purpose utility — not a general PDF ingestion
// system. Regenerates the high-resolution PNG derivatives of the one
// verified real SolarDesk proposal-example PDF
// (brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf)
// that lib/agent/proposalExamples.ts composes into marketing assets.
// Run this only if that PDF is ever replaced with a newer verified
// example. It never modifies the source PDF itself.
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const PDF_PATH = "brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf";
const OUT_DIR = "brands/solardesk/assets/proposal-examples/rendered";
const PAGE_COUNT = 2;
const DPI = 300;

const buf = readFileSync(PDF_PATH);
const doc = mupdf.Document.openDocument(buf, "application/pdf");
mkdirSync(OUT_DIR, { recursive: true });

const scale = DPI / 72;
const matrix = mupdf.Matrix.scale(scale, scale);

for (let i = 0; i < PAGE_COUNT; i++) {
  const page = doc.loadPage(i);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const outPath = `${OUT_DIR}/page-${i + 1}.png`;
  writeFileSync(outPath, pixmap.asPNG());
  console.log(`wrote ${outPath}`);
  pixmap.destroy();
}
