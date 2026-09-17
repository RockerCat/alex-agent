import { EXECUTOR_TEXT_LIMITS, executorOutputSchema, type ExecutorOutput } from "@/lib/agent/schemas";
import { scanDraftForProductTruthViolations, type ProductTruthViolation } from "@/lib/agent/productTruth";
import { isMechanicallyTruncated } from "@/lib/agent/mechanicalTruncation";
import { containsEmbeddedUrl } from "@/lib/agent/cta";
import type { ContentBrief } from "@/lib/agent/schemas";

export interface DraftValidationResult {
  valid: boolean;
  errors: string[];
  violations: ProductTruthViolation[];
  output?: ExecutorOutput;
}

// Channel Content Rules v1 — deterministic format invariants (hard
// structural rules, not editorial targets). A carousel's slide *count*
// range and an image_post's single-panel requirement are format
// semantics, not prose quality, so they belong here rather than in the
// Executor's prompt guidance alone.
const CAROUSEL_MIN_SLIDES = 3;
const CAROUSEL_MAX_SLIDES = 6;
const IMAGE_POST_SLIDE_COUNT = 1;

/**
 * Secondary, deterministic defense against mechanical truncation
 * (spec section 19 / live incident, 2026-09-09): OpenAI Structured
 * Outputs' constrained decoding can force-close a string exactly at its
 * JSON Schema `maxLength` — derived from the `.max()` limits in
 * EXECUTOR_TEXT_LIMITS — producing syntactically valid, schema-compliant
 * JSON whose prose is nonetheless cut off mid-sentence. The primary
 * defense is aiClient.ts checking the Responses API's own
 * `status`/`incomplete_details` signal; this exists only for the
 * narrower case that signal doesn't cover — the model (or the API)
 * completes the call "successfully" while having silently respected the
 * stated field limit by truncating prose to fit exactly, with no
 * incomplete flag raised at all.
 *
 * Deliberately narrow: flags a field ONLY when it lands at EXACTLY its
 * schema ceiling AND does not end in ordinary closing punctuation. A
 * natural string coincidentally landing on an exact character count,
 * while also ending some other way, is astronomically unlikely — this
 * is a structural/mechanical signal, not prose-quality analysis, and it
 * never rejects legitimate copy for being short, blunt, or ending in an
 * emoji.
 */
function findMechanicalTruncation(output: ExecutorOutput): string[] {
  const problems: string[] = [];

  const checkField = (label: string, text: string, limit: number) => {
    if (isMechanicallyTruncated(text, limit)) {
      problems.push(`${label} appears mechanically truncated at its ${limit}-character limit`);
    }
  };

  checkField("title", output.title, EXECUTOR_TEXT_LIMITS.title);
  checkField("hook", output.hook, EXECUTOR_TEXT_LIMITS.hook);
  checkField("caption", output.caption, EXECUTOR_TEXT_LIMITS.caption);
  checkField("cta", output.cta, EXECUTOR_TEXT_LIMITS.cta);
  checkField("visualDirection", output.visualDirection, EXECUTOR_TEXT_LIMITS.visualDirection);
  output.slides.forEach((slide, i) => checkField(`slides[${i}].text`, slide.text, EXECUTOR_TEXT_LIMITS.slideText));

  return problems;
}

/**
 * Validates an Executor response before it may be persisted as a draft:
 * schema shape, format-specific structural requirements, a deterministic
 * Product Truth scan (spec section 19), and a secondary mechanical-
 * truncation check that does not rely on the model having followed
 * prompt instructions or on the Responses API having flagged the call.
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

  if (brief.format === "carousel" && (output.slides.length < CAROUSEL_MIN_SLIDES || output.slides.length > CAROUSEL_MAX_SLIDES)) {
    errors.push(`carousel format requires between ${CAROUSEL_MIN_SLIDES} and ${CAROUSEL_MAX_SLIDES} slides`);
  }

  if (brief.format === "image_post" && output.slides.length !== IMAGE_POST_SLIDE_COUNT) {
    errors.push(`image_post format requires exactly ${IMAGE_POST_SLIDE_COUNT} slide`);
  }

  // CTA label/destination contract (real production incident,
  // 2026-09-17): cta is rendered directly into the image as a single
  // line of text — a URL never belongs there, whether or not the brief
  // supplied a separate ctaUrl (see lib/agent/cta.ts).
  if (containsEmbeddedUrl(output.cta)) {
    errors.push("cta must be a short label and must not contain a URL — the renderer displays cta directly in the image");
  }

  if (output.unresolvedFactualGap) {
    return { valid: false, errors: ["executor reported an unresolved factual gap"], violations: [], output };
  }

  errors.push(...findMechanicalTruncation(output));

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
