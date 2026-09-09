import { EXECUTOR_TEXT_LIMITS, executorOutputSchema, type ExecutorOutput } from "@/lib/agent/schemas";
import { scanDraftForProductTruthViolations, type ProductTruthViolation } from "@/lib/agent/productTruth";
import type { ContentBrief } from "@/lib/agent/schemas";

export interface DraftValidationResult {
  valid: boolean;
  errors: string[];
  violations: ProductTruthViolation[];
  output?: ExecutorOutput;
}

// A string ending in one of these is presumed a deliberately finished
// thought (a sentence, a quote, a trailing colon before a list rendered
// elsewhere, a closing parenthesis). Intentionally short and permissive:
// this is not a grammar checker, and legitimate copy ending in an emoji
// or other character outside this set is never flagged by this alone —
// only the exact-length match below (see findMechanicalTruncation) does
// that work.
const TERMINAL_CHARACTERS = new Set([".", "!", "?", "…", '"', "”", "'", "’", ")", ":"]);

function endsWithTerminalCharacter(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.length > 0 && TERMINAL_CHARACTERS.has(trimmed[trimmed.length - 1]);
}

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
    if (text.length === limit && !endsWithTerminalCharacter(text)) {
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

  if (brief.format === "carousel" && output.slides.length < 3) {
    errors.push("carousel format requires at least 3 slides");
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
