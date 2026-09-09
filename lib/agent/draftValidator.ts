import { executorOutputSchema, type ExecutorOutput } from "@/lib/agent/schemas";
import { scanDraftForProductTruthViolations, type ProductTruthViolation } from "@/lib/agent/productTruth";
import type { ContentBrief } from "@/lib/agent/schemas";

export interface DraftValidationResult {
  valid: boolean;
  errors: string[];
  violations: ProductTruthViolation[];
  output?: ExecutorOutput;
}

/**
 * Validates an Executor response before it may be persisted as a draft:
 * schema shape, format-specific structural requirements, and a
 * deterministic Product Truth scan (spec section 19) that does not rely
 * on the model having followed prompt instructions.
 */
export function validateDraft(raw: unknown, brief: ContentBrief): DraftValidationResult {
  const parsed = executorOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      violations: [],
    };
  }

  const output = parsed.data;
  const errors: string[] = [];

  if (brief.format === "carousel" && output.slides.length < 3) {
    errors.push("carousel format requires at least 3 slides");
  }

  if (output.unresolvedFactualGap) {
    return { valid: false, errors: ["executor reported an unresolved factual gap"], violations: [], output };
  }

  const violations = scanDraftForProductTruthViolations(output);
  if (violations.length > 0) {
    errors.push(
      `Product Truth violation(s): ${violations.map((v) => `${v.category}:${v.pattern}`).join(", ")}`
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors, violations, output };
  }

  return { valid: true, errors: [], violations: [], output };
}
