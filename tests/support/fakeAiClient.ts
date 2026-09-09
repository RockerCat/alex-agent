import type { AiClient, PlannerCallInput, ExecutorCallInput, AiCallResult } from "@/lib/agent/aiClient";
import type { PlannerOutput, ExecutorOutput } from "@/lib/agent/schemas";

/**
 * Scripted stand-in for the OpenAI-backed AiClient. Tests queue up
 * responses in call order; if the queue runs out, the last entry repeats
 * (handy for retry-loop tests that don't care how many times a bad
 * response is returned).
 */
export class ScriptedAiClient implements AiClient {
  plannerCalls: PlannerCallInput[] = [];
  executorCalls: ExecutorCallInput[] = [];

  /**
   * When > 0, the next runExecutor call throws instead of returning a
   * scripted output (simulating a technical failure — network error,
   * process crash mid-call — rather than a bad-but-parseable response).
   * Decrements on each throw.
   */
  failNextExecutorCalls = 0;

  constructor(
    private plannerQueue: PlannerOutput[] = [],
    private executorQueue: ExecutorOutput[] = []
  ) {}

  async runPlanner(input: PlannerCallInput): Promise<AiCallResult<PlannerOutput>> {
    this.plannerCalls.push(input);
    const output = this.plannerQueue.length > 1 ? this.plannerQueue.shift()! : this.plannerQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no planner output queued");
    return { output, usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 400 }, model: "test-planner-model" };
  }

  async runExecutor(input: ExecutorCallInput): Promise<AiCallResult<ExecutorOutput>> {
    this.executorCalls.push(input);
    if (this.failNextExecutorCalls > 0) {
      this.failNextExecutorCalls -= 1;
      throw new Error("Simulated technical failure calling the Executor model.");
    }
    const output = this.executorQueue.length > 1 ? this.executorQueue.shift()! : this.executorQueue[0];
    if (!output) throw new Error("ScriptedAiClient: no executor output queued");
    return { output, usage: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 500 }, model: "test-executor-model" };
  }
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
