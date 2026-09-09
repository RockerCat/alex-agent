// Deterministic Product Truth enforcement (ALEXAGENT_V0.1_SPEC.md section 19).
//
// This is intentionally NOT an AI judgment call: it is a fixed list of
// phrase patterns that are never allowed to reach a SolarDesk draft,
// mirrored directly from brands/solardesk/BRAND.md ("Veracidad y
// aprobación" and "No anunciar como disponibles sin nueva verificación").
// The Planner/Executor prompts also instruct the model to respect these
// boundaries, but enforcement here does not depend on the model
// complying — every draft is scanned before it can reach pending_approval.

export interface ProductTruthViolation {
  pattern: string;
  matchedText: string;
  category: "fabrication" | "unavailable_capability" | "unverified_guarantee";
}

interface RuleDef {
  regex: RegExp;
  category: ProductTruthViolation["category"];
  label: string;
}

const FABRICATION_RULES: RuleDef[] = [
  { regex: /testimoni[oa]s?/i, category: "fabrication", label: "testimonial claim" },
  { regex: /nuestros?\s+clientes?\s+(dicen|reportan|logran|obtuvieron)/i, category: "fabrication", label: "fabricated customer claim" },
  { regex: /\balianza\s+con\b/i, category: "fabrication", label: "fabricated partnership" },
  { regex: /\bpremiad[oa]s?\b|\bganador(a)?\s+del?\s+premio\b/i, category: "fabrication", label: "fabricated award" },
  { regex: /\bcertificad[oa]s?\s+por\b/i, category: "fabrication", label: "unverified certification" },
  { regex: /\b\d+([.,]\d+)?%\s*(de\s+)?(clientes|usuarios|instaladores)\b/i, category: "fabrication", label: "fabricated statistic" },
  { regex: /\b(usuarios|clientes)\s+(activos|reales)\b.{0,20}\b\d+/i, category: "fabrication", label: "fabricated usage statistic" },
];

const UNAVAILABLE_CAPABILITY_RULES: RuleDef[] = [
  { regex: /simulaci[oó]n\s+de\s+financiaci[oó]n/i, category: "unavailable_capability", label: "financing simulation (not available)" },
  { regex: /\bCRM\s+avanzado\b/i, category: "unavailable_capability", label: "advanced CRM (not available)" },
  { regex: /seguimiento\s+autom[aá]tico.{0,20}whatsapp|whatsapp.{0,20}autom[aá]tic[oa]/i, category: "unavailable_capability", label: "automated WhatsApp follow-up (not available)" },
  { regex: /aplicaci[oó]n\s+m[oó]vil|app\s+m[oó]vil/i, category: "unavailable_capability", label: "mobile app (not available)" },
  { regex: /API.{0,15}irradiaci[oó]n.{0,15}(en\s+vivo|tiempo\s+real)|irradiaci[oó]n.{0,15}tiempo\s+real/i, category: "unavailable_capability", label: "live irradiance API (not available)" },
  { regex: /m[uú]ltiples\s+plantillas\s+(de\s+)?PDF/i, category: "unavailable_capability", label: "multiple PDF templates (not available)" },
];

const GUARANTEE_RULES: RuleDef[] = [
  { regex: /ahorro\s+garantizado|retorno\s+garantizado|rentabilidad\s+garantizada/i, category: "unverified_guarantee", label: "guaranteed savings/return" },
  { regex: /aumento\s+(de\s+)?ventas\s+garantizado/i, category: "unverified_guarantee", label: "guaranteed sales increase" },
  { regex: /garant[ií]a\s+de\s+por\s+vida/i, category: "unverified_guarantee", label: "lifetime guarantee" },
  { regex: /100%\s+(seguro|preciso|garantizado)/i, category: "unverified_guarantee", label: "absolute certainty/security claim" },
];

const ALL_RULES = [...FABRICATION_RULES, ...UNAVAILABLE_CAPABILITY_RULES, ...GUARANTEE_RULES];

export function scanTextForProductTruthViolations(text: string): ProductTruthViolation[] {
  if (!text) return [];
  const violations: ProductTruthViolation[] = [];
  for (const rule of ALL_RULES) {
    const match = text.match(rule.regex);
    if (match) {
      violations.push({
        pattern: rule.label,
        matchedText: match[0],
        category: rule.category,
      });
    }
  }
  return violations;
}

export interface DraftLikeText {
  title?: string | null;
  hook?: string | null;
  caption?: string | null;
  cta?: string | null;
  slides?: { text: string }[];
}

export function scanDraftForProductTruthViolations(draft: DraftLikeText): ProductTruthViolation[] {
  const combined = [
    draft.title ?? "",
    draft.hook ?? "",
    draft.caption ?? "",
    draft.cta ?? "",
    ...(draft.slides ?? []).map((s) => s.text),
  ].join("\n");
  return scanTextForProductTruthViolations(combined);
}
