import type { RunStatus, StepStatus } from "@orchestrator/shared";

/** Eventos do ciclo de vida de um passo (data-model.md, "Máquina de estados"). Puro, sem I/O. */
export const STEP_EVENTS = [
  "start",
  "agent_success",
  "agent_error",
  "ref_violation",
  "interrupt",
  "timeout",
  "shutdown",
  "reply",
  "advance",
] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

export class InvalidTransition extends Error {
  constructor(
    readonly from: string,
    readonly event: string,
  ) {
    super(`Transição inválida: ${from} --${event}-->`);
    this.name = "InvalidTransition";
  }
}

/** Tabela StepStatus de data-model.md. Qualquer combinação fora dela lança `InvalidTransition`. */
export function transitionStep(status: StepStatus, event: StepEvent, options: { interactive: boolean }): StepStatus {
  switch (status) {
    case "waiting":
      if (event === "start") return "running";
      break;
    case "running":
      switch (event) {
        case "agent_success":
          return options.interactive ? "awaiting_input" : "completed";
        case "agent_error":
        case "ref_violation":
          return "failed";
        case "interrupt":
        case "timeout":
        case "shutdown":
          return "interrupted";
        default:
          break;
      }
      break;
    case "awaiting_input":
      switch (event) {
        case "reply":
          return "running";
        case "advance":
          return "completed";
        case "ref_violation":
          return "failed";
        case "interrupt":
        case "shutdown":
          return "interrupted";
        default:
          break;
      }
      break;
    case "completed":
    case "failed":
    case "interrupted":
      break;
  }
  throw new InvalidTransition(status, event);
}

/**
 * Tabela RunStatus de data-model.md: o status da execução a partir do novo status do passo atual.
 * `isLastStep` decide se um passo `completed` encerra a execução ou leva ao próximo passo.
 */
export function transitionRun(status: RunStatus, stepStatus: StepStatus, options: { isLastStep: boolean }): RunStatus {
  if (status === "running" || status === "awaiting_input") {
    switch (stepStatus) {
      case "running":
        return "running";
      case "awaiting_input":
        if (status === "running") return "awaiting_input";
        break;
      case "completed":
        return options.isLastStep ? "completed" : "running";
      case "failed":
        return "failed";
      case "interrupted":
        return "interrupted";
      case "waiting":
        break;
    }
  }
  throw new InvalidTransition(status, `step:${stepStatus}`);
}
