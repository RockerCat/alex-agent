import type {
  AiClient,
  PlannerCallInput,
  ExecutorCallInput,
  AiCallResult,
  ExecutorCallResult,
  AssetFeedbackCallInput,
  AssetFeedbackCallResult,
  VisualDirectorCallInput,
  VisualDirectorCallResult,
} from "@/lib/agent/aiClient";
import {
  EXECUTOR_TEXT_LIMITS,
  DEFAULT_RENDER_SPEC,
  type PlannerOutput,
  type ExecutorOutput,
  type AssetRenderSpec,
  type AssetFeedbackInterpretation,
  type VisualCreativePlan,
} from "@/lib/agent/schemas";

/**
 * Scripted stand-in for the OpenAI-backed AiClient. Tests queue up
 * responses in call order; if the queue runs out, the last entry repeats
 * (handy for retry-loop tests that don't care how many times a bad
 * response is returned).
 */
export class ScriptedAiClient implements AiClient {
  plannerCalls: PlannerCallInput[] = [];
  executorCalls: ExecutorCallInput[] = [];
  assetFeedbackCalls: AssetFeedbackCallInput[] = [];
  visualDirectorCalls: VisualDirectorCallInput[] = [];

  /**
   * When > 0, the next runExecutor call throws instead of returning a
   * scripted output (simulating a technical failure — network error,
   * process crash mid-call — rather than a bad-but-parseable response).
   * Decrements on each throw.
   */
  failNextExecutorCalls = 0;

  /** Same as failNextExecutorCalls, for runAssetFeedbackInterpreter. */
  failNextAssetFeedbackCalls = 0;

  /**
   * FIFO queue of "this call's Responses API response was incomplete"
   * reasons (e.g. "max_output_tokens"). Consumed one per runExecutor
   * call, ahead of the normal executorQueue, so a test can script "call
   * 1 incomplete, call 2 succeeds" without touching the output queue at
   * all — matching how the real OpenAiClient reports incomplete calls
   * with no usable `output`.
   */
  incompleteExecutorReasons: string[] = [];

  /** Same as incompleteExecutorReasons, for runAssetFeedbackInterpreter. */
  incompleteAssetFeedbackReasons: string[] = [];

  /** Same as failNextExecutorCalls, for runVisualDirector. */
  failNextVisualDirectorCalls = 0;
  /** Same as incompleteExecutorReasons, for runVisualDirector. */
  incompleteVisualDirectorReasons: string[] = [];

  constructor(
    private plannerQueue: PlannerOutput[] = [],
    private executorQueue: ExecutorOutput[] = [],
    private assetFeedbackQueue: AssetFeedbackInterpretation[] = [
      { renderSpec: DEFAULT_RENDER_SPEC, appliedChanges: [], unsupportedRequests: [] },
    ],
    private visualDirectorQueue: VisualCreativePlan[] = [defaultVisualPlan()]
  ) {}

  async runPlanner(input: PlannerCallInput): Promise<AiCallResult<PlannerOutput>> {
    this.plannerCalls.push(input);
    const output = this.plannerQueue.length > 1 ? this.plannerQueue.shift()! : this.plannerQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no planner output queued");
    return { output, usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 400 }, model: "test-planner-model" };
  }

  async runExecutor(input: ExecutorCallInput): Promise<ExecutorCallResult> {
    this.executorCalls.push(input);
    if (this.failNextExecutorCalls > 0) {
      this.failNextExecutorCalls -= 1;
      throw new Error("Simulated technical failure calling the Executor model.");
    }
    const usage = { inputTokens: 600, cachedInputTokens: 0, outputTokens: 500 };
    const model = "test-executor-model";
    if (this.incompleteExecutorReasons.length > 0) {
      const reason = this.incompleteExecutorReasons.shift()!;
      return { usage, model, incomplete: { reason } };
    }
    const output = this.executorQueue.length > 1 ? this.executorQueue.shift()! : this.executorQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no executor output queued");
    return { output, usage, model };
  }

  async runAssetFeedbackInterpreter(input: AssetFeedbackCallInput): Promise<AssetFeedbackCallResult> {
    this.assetFeedbackCalls.push(input);
    if (this.failNextAssetFeedbackCalls > 0) {
      this.failNextAssetFeedbackCalls -= 1;
      throw new Error("Simulated technical failure calling the asset feedback interpreter.");
    }
    const usage = { inputTokens: 300, cachedInputTokens: 0, outputTokens: 40 };
    const model = "test-executor-model";
    if (this.incompleteAssetFeedbackReasons.length > 0) {
      const reason = this.incompleteAssetFeedbackReasons.shift()!;
      return { usage, model, incomplete: { reason } };
    }
    const output = this.assetFeedbackQueue.length > 1 ? this.assetFeedbackQueue.shift()! : this.assetFeedbackQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no asset feedback output queued");
    return { output, usage, model };
  }

  async runVisualDirector(input: VisualDirectorCallInput): Promise<VisualDirectorCallResult> {
    this.visualDirectorCalls.push(input);
    if (this.failNextVisualDirectorCalls > 0) {
      this.failNextVisualDirectorCalls -= 1;
      throw new Error("Simulated technical failure calling the Visual Director.");
    }
    const usage = { inputTokens: 500, cachedInputTokens: 0, outputTokens: 200 };
    const model = "test-executor-model";
    if (this.incompleteVisualDirectorReasons.length > 0) {
      const reason = this.incompleteVisualDirectorReasons.shift()!;
      return { usage, model, incomplete: { reason } };
    }
    const output = this.visualDirectorQueue.length > 1 ? this.visualDirectorQueue.shift()! : this.visualDirectorQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no visual director output queued");
    return { output, usage, model };
  }
}

/** Test convenience: a valid, minimal VisualCreativePlan with sensible defaults, overridable per field. */
export function visualPlan(overrides: Partial<VisualCreativePlan> = {}): VisualCreativePlan {
  return {
    strategy: "branded_graphic",
    creativeConcept: "Composición de marca con titular y CTA, sin imagen de producto ni propuesta.",
    communicationGoal: "Comunicar la idea central del post de forma clara y directa.",
    verifiedSourceCategory: "none",
    generativeSceneDescription: null,
    compositionIntent: "graphic_text_dominant",
    renderSpec: DEFAULT_RENDER_SPEC,
    rationale: "El tema es conceptual/educativo, no una demostración de producto ni de la propuesta.",
    ...overrides,
  };
}

function defaultVisualPlan(): VisualCreativePlan {
  return visualPlan();
}

/**
 * Test convenience: wrap a bare AssetRenderSpec into a full
 * AssetFeedbackInterpretation, defaulting appliedChanges to a single
 * generic summary (so a scripted "the spec changed" response still
 * reads as an applied, not an unsupported, change unless a test
 * overrides it) and unsupportedRequests to empty.
 */
export function feedbackInterpretation(
  renderSpec: AssetRenderSpec,
  overrides: Partial<Pick<AssetFeedbackInterpretation, "appliedChanges" | "unsupportedRequests">> = {}
): AssetFeedbackInterpretation {
  return {
    renderSpec,
    appliedChanges: overrides.appliedChanges ?? ["Ajuste visual aplicado"],
    unsupportedRequests: overrides.unsupportedRequests ?? [],
  };
}

export function carouselExecutorOutput(overrides: Partial<ExecutorOutput> = {}): ExecutorOutput {
  return {
    title: "Presenta propuestas solares profesionales",
    hook: "¿Sigues armando propuestas solares en hojas de cálculo?",
    slides: [
      { slide: 1, text: "Centraliza clientes y propuestas en un solo lugar." },
      { slide: 2, text: "Agrega la identidad de tu empresa a cada PDF." },
      { slide: 3, text: "Comparte un enlace interactivo con tu cliente." },
    ],
    caption: "Cotiza proyectos solares y presenta propuestas profesionales con la marca de tu empresa.",
    cta: "Crea tu primera cotización",
    visualDirection: "SaaS B2B limpio, azul oscuro y ámbar, sin imágenes genéricas de paneles.",
    hashtags: ["#energiasolar", "#solardesk"],
    unresolvedFactualGap: null,
    ...overrides,
  };
}

function fillToExactLength(limit: number, tail: string, filler: string): string {
  const padLength = Math.max(0, limit - tail.length);
  const padding = filler.repeat(Math.ceil(padLength / filler.length)).slice(0, padLength);
  return (padding + tail).slice(0, limit);
}

/**
 * Regression fixture modeled on the live incident (2026-09-09): a
 * carousel slide and visualDirection cut off mid-sentence in an
 * otherwise formally successful Structured Output, while caption stayed
 * complete. Constructed to land EXACTLY at each field's current schema
 * ceiling (EXECUTOR_TEXT_LIMITS) — the one shape the mechanical-
 * truncation check in lib/agent/draftValidator.ts can deterministically
 * detect. A truncation landing short of the exact boundary (which the
 * real incident may well have been, under the pre-fix limits) is not
 * caught by that heuristic and instead relies on the Responses API's
 * own incomplete/status signal (see ScriptedAiClient.incompleteExecutorReasons
 * above and aiClient.ts's runExecutor) — this fixture exists to
 * stress-test the secondary defense specifically, in isolation from that
 * primary one.
 */
export function liveIncidentShapedTruncatedOutput(): ExecutorOutput {
  const slideText = fillToExactLength(
    EXECUTOR_TEXT_LIMITS.slideText,
    "Importante: son estimaciones, no una garantía financiera, de generación",
    "Las cifras se calculan a partir de los datos técnicos y la irradiación local. "
  );
  const visualDirection = fillToExactLength(
    EXECUTOR_TEXT_LIMITS.visualDirection,
    'Mantener el texto principal legible en móvil y añadir una nota breve: "Estimaciones basadas en supuestos; no son',
    "SaaS B2B limpio, azul oscuro y ámbar, sin imágenes genéricas de paneles solares. "
  );

  return carouselExecutorOutput({
    slides: [
      { slide: 1, text: "Centraliza clientes y propuestas en un solo lugar." },
      { slide: 2, text: "Agrega la identidad de tu empresa a cada PDF." },
      { slide: 3, text: slideText },
    ],
    caption: "No son garantías de generación ni de resultados financieros.",
    visualDirection,
  });
}

export function createPlanOutput(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    decision: "CREATE_PLAN",
    primaryObjective: {
      type: "SIGNUPS",
      reason: "SolarDesk has no active users yet; the priority is getting new installers to register and try it.",
      successSignal: "New registrations for the period",
    },
    supportingObjectives: ["ACTIVATION"],
    strategy: {
      summary: "Demonstrate the proposal workflow to installers so they register and complete a first quote.",
      audience: "Solar installers and engineers in Colombia",
      approach: "Educational carousels showing the quote-to-proposal flow with a fictional example.",
    },
    content: [
      {
        purpose: "education",
        channel: "instagram",
        format: "carousel",
        topic: "Cómo pasar de una cotización a una propuesta profesional",
        audience: "Instaladores solares en Colombia",
        cta: "Crea tu primera cotización",
        targetDate: "2026-09-12",
      },
    ],
    humanQuestion: null,
    rationale: "No active plan exists and no users are active yet, so the priority is driving registrations and first-quote activation.",
    ...overrides,
  };
}
