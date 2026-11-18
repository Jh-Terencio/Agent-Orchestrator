import { describe, expect, it } from "vitest";
import { RunStatusSchema, StepStatusSchema, type RunStatus, type StepStatus } from "@orchestrator/shared";
import {
  InvalidTransition,
  STEP_EVENTS,
  transitionRun,
  transitionStep,
  type StepEvent,
} from "../../src/execution/state-machine.js";

type Row = [from: StepStatus, event: StepEvent, interactive: boolean | "any", to: StepStatus];

/** Tabela StepStatus de data-model.md, linha a linha. */
const STEP_TABLE: Row[] = [
  ["waiting", "start", "any", "running"],
  ["running", "agent_success", false, "completed"],
  ["running", "agent_success", true, "awaiting_input"],
  ["running", "agent_error", "any", "failed"],
  ["running", "ref_violation", "any", "failed"],
  ["running", "interrupt", "any", "interrupted"],
  ["running", "timeout", "any", "interrupted"],
  ["running", "shutdown", "any", "interrupted"],
  ["awaiting_input", "reply", "any", "running"],
  ["awaiting_input", "advance", "any", "completed"],
  ["awaiting_input", "ref_violation", "any", "failed"],
  ["awaiting_input", "interrupt", "any", "interrupted"],
  ["awaiting_input", "shutdown", "any", "interrupted"],
  ["running", "permission_request", "any", "awaiting_permission"],
  ["awaiting_permission", "permission_request", "any", "awaiting_permission"],
  ["awaiting_permission", "permission_decision", "any", "running"],
  ["awaiting_permission", "interrupt", "any", "interrupted"],
  ["awaiting_permission", "shutdown", "any", "interrupted"],
];

function expected(from: StepStatus, event: StepEvent, interactive: boolean): StepStatus | undefined {
  return STEP_TABLE.find(
    ([rowFrom, rowEvent, rowInteractive]) =>
      rowFrom === from && rowEvent === event && (rowInteractive === "any" || rowInteractive === interactive),
  )?.[3];
}

describe("transitionStep", () => {
  for (const [from, event, interactive, to] of STEP_TABLE) {
    const modes = interactive === "any" ? [false, true] : [interactive];
    for (const mode of modes) {
      it(`${from} --${event}${mode ? " (interativo)" : ""}--> ${to}`, () => {
        expect(transitionStep(from, event, { interactive: mode })).toBe(to);
      });
    }
  }

  it("toda combinação não listada lança InvalidTransition com from/event", () => {
    let invalidCount = 0;
    for (const from of StepStatusSchema.options) {
      for (const event of STEP_EVENTS) {
        for (const interactive of [false, true]) {
          if (expected(from, event, interactive) !== undefined) continue;
          invalidCount++;
          let caught: unknown;
          try {
            transitionStep(from, event, { interactive });
          } catch (error) {
            caught = error;
          }
          expect(caught, `${from} + ${event}`).toBeInstanceOf(InvalidTransition);
          expect(caught).toMatchObject({ from, event });
        }
      }
    }
    expect(invalidCount).toBeGreaterThan(0);
  });

  it("timeout em awaiting_input é inválido (a pausa não conta tempo)", () => {
    expect(() => transitionStep("awaiting_input", "timeout", { interactive: true })).toThrow(InvalidTransition);
  });

  it("em awaiting_permission, timeout, reply, advance e agent_success são inválidos (timer pausado)", () => {
    for (const event of ["timeout", "reply", "advance", "agent_success", "agent_error"] as const) {
      expect(() => transitionStep("awaiting_permission", event, { interactive: true })).toThrow(InvalidTransition);
    }
  });

  it("qualquer evento em estado terminal é inválido", () => {
    for (const from of ["completed", "failed", "interrupted"] as const) {
      for (const event of STEP_EVENTS) {
        expect(() => transitionStep(from, event, { interactive: true })).toThrow(InvalidTransition);
      }
    }
  });
});

type RunRow = [from: RunStatus, step: StepStatus, isLastStep: boolean | "any", to: RunStatus];

/** Tabela RunStatus de data-model.md: o status da execução segue o novo status do passo atual. */
const RUN_TABLE: RunRow[] = [
  ["running", "running", "any", "running"],
  ["running", "awaiting_input", "any", "awaiting_input"],
  ["awaiting_input", "running", "any", "running"],
  ["running", "completed", false, "running"],
  ["awaiting_input", "completed", false, "running"],
  ["running", "completed", true, "completed"],
  ["awaiting_input", "completed", true, "completed"],
  ["running", "failed", "any", "failed"],
  ["awaiting_input", "failed", "any", "failed"],
  ["running", "interrupted", "any", "interrupted"],
  ["awaiting_input", "interrupted", "any", "interrupted"],
  ["running", "awaiting_permission", "any", "awaiting_permission"],
  ["awaiting_permission", "awaiting_permission", "any", "awaiting_permission"],
  ["awaiting_permission", "running", "any", "running"],
  ["awaiting_permission", "interrupted", "any", "interrupted"],
];

describe("transitionRun", () => {
  for (const [from, step, isLastStep, to] of RUN_TABLE) {
    const modes = isLastStep === "any" ? [false, true] : [isLastStep];
    for (const mode of modes) {
      it(`${from} + passo ${step}${mode ? " (último)" : ""} → ${to}`, () => {
        expect(transitionRun(from, step, { isLastStep: mode })).toBe(to);
      });
    }
  }

  it("awaiting_input → failed quando o passo vai a failed (ref_violation ao avançar)", () => {
    const step = transitionStep("awaiting_input", "ref_violation", { interactive: true });
    expect(transitionRun("awaiting_input", step, { isLastStep: false })).toBe("failed");
  });

  it("combinações não listadas lançam InvalidTransition", () => {
    for (const from of RunStatusSchema.options) {
      for (const step of StepStatusSchema.options) {
        for (const isLastStep of [false, true]) {
          const listed = RUN_TABLE.some(
            ([rowFrom, rowStep, rowLast]) =>
              rowFrom === from && rowStep === step && (rowLast === "any" || rowLast === isLastStep),
          );
          if (listed) continue;
          expect(() => transitionRun(from, step, { isLastStep }), `${from} + ${step}`).toThrow(InvalidTransition);
        }
      }
    }
  });
});
