import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { createDefaultPipeline } from "../src/default-pipeline.js";
import {
  DEFAULT_TIMEOUT_MINUTES,
  PipelineInputSchema,
  PipelineSchema,
  StepInputSchema,
  StepSchema,
} from "../src/schemas/pipeline.js";

const NOW = "2026-11-17T00:00:00.000Z";

function validStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Specify",
    model: "sonnet",
    command: "/speckit-specify",
    interactive: false,
    ...overrides,
  };
}

function validPipeline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Minha esteira",
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    steps: [
      validStep(),
      validStep({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Plan",
        model: "opus",
        command: "/speckit-plan",
      }),
    ],
    ...overrides,
  };
}

function issuesOf(result: z.ZodSafeParseResult<unknown>): { path: PropertyKey[]; message: string }[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function stepsWith(index: number, overrides: Record<string, unknown>): Record<string, unknown>[] {
  const pipeline = validPipeline();
  const steps = [...(pipeline.steps as Record<string, unknown>[])];
  steps[index] = { ...steps[index], ...overrides };
  return steps;
}

describe("PipelineSchema", () => {
  it("aceita a esteira padrão", () => {
    const result = PipelineSchema.safeParse(createDefaultPipeline(NOW));
    expect(issuesOf(result)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("aceita uma esteira válida", () => {
    expect(PipelineSchema.safeParse(validPipeline()).success).toBe(true);
  });

  it('rejeita name "" com a mensagem do contrato', () => {
    const result = PipelineSchema.safeParse(validPipeline({ name: "" }));
    expect(issuesOf(result)).toContainEqual({ path: ["name"], message: "Informe um nome para a esteira" });
  });

  it("rejeita name só com espaços (vazio após trim)", () => {
    const result = PipelineSchema.safeParse(validPipeline({ name: "   " }));
    expect(issuesOf(result)).toContainEqual({ path: ["name"], message: "Informe um nome para a esteira" });
  });

  it("rejeita name com 81 caracteres após trim e aceita 80 com espaços nas pontas", () => {
    expect(PipelineSchema.safeParse(validPipeline({ name: `  ${"a".repeat(81)}  ` })).success).toBe(false);

    const ok = PipelineSchema.safeParse(validPipeline({ name: `  ${"a".repeat(80)}  ` }));
    expect(ok.success).toBe(true);
    expect(ok.data?.name).toBe("a".repeat(80));
  });

  it("rejeita steps: [] com a mensagem do contrato", () => {
    const result = PipelineSchema.safeParse(validPipeline({ steps: [] }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps"],
      message: "A esteira precisa de pelo menos um passo",
    });
  });

  it("rejeita passo sem command com a mensagem do contrato", () => {
    const steps = stepsWith(1, {});
    delete steps[1]!.command;
    const result = PipelineSchema.safeParse(validPipeline({ steps }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps", 1, "command"],
      message: "Informe a skill ou comando do passo",
    });
  });

  it("rejeita passo com command vazio com a mensagem do contrato", () => {
    const result = PipelineSchema.safeParse(validPipeline({ steps: stepsWith(0, { command: "  " }) }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps", 0, "command"],
      message: "Informe a skill ou comando do passo",
    });
  });

  it("rejeita timeoutMinutes: 0 com a mensagem do contrato", () => {
    const result = PipelineSchema.safeParse(validPipeline({ steps: stepsWith(1, { timeoutMinutes: 0 }) }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps", 1, "timeoutMinutes"],
      message: "O limite de tempo deve estar entre 1 e 1440 minutos",
    });
  });

  it.each([1441, 1.5])("rejeita timeoutMinutes: %s", (timeoutMinutes) => {
    const result = PipelineSchema.safeParse(validPipeline({ steps: stepsWith(0, { timeoutMinutes }) }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps", 0, "timeoutMinutes"],
      message: "O limite de tempo deve estar entre 1 e 1440 minutos",
    });
  });

  it.each([1, 1440])("aceita timeoutMinutes: %s", (timeoutMinutes) => {
    expect(PipelineSchema.safeParse(validPipeline({ steps: stepsWith(0, { timeoutMinutes }) })).success).toBe(true);
  });

  it("rejeita dois passos com o mesmo nome com a mensagem do contrato", () => {
    const result = PipelineSchema.safeParse(validPipeline({ steps: stepsWith(1, { name: "Specify" }) }));
    expect(issuesOf(result)).toContainEqual({
      path: ["steps", 1, "name"],
      message: "Já existe um passo com este nome",
    });
  });

  it("rejeita nome de passo com 61 caracteres e aceita 60", () => {
    expect(PipelineSchema.safeParse(validPipeline({ steps: stepsWith(0, { name: "p".repeat(61) }) })).success).toBe(
      false,
    );
    expect(PipelineSchema.safeParse(validPipeline({ steps: stepsWith(0, { name: "p".repeat(60) }) })).success).toBe(
      true,
    );
  });

  it("rejeita schemaVersion diferente de 1", () => {
    expect(PipelineSchema.safeParse(validPipeline({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe("StepSchema", () => {
  it("interactive ausente vira false", () => {
    const step = validStep();
    delete step.interactive;
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    expect(result.data?.interactive).toBe(false);
  });

  it("rejeita model vazio", () => {
    expect(StepSchema.safeParse(validStep({ model: "" })).success).toBe(false);
  });

  it("exige id uuid", () => {
    expect(StepSchema.safeParse(validStep({ id: "abc" })).success).toBe(false);
  });
});

describe("StepInputSchema e PipelineInputSchema", () => {
  it("StepInput aceita passo sem id", () => {
    const step = validStep();
    delete step.id;
    expect(StepInputSchema.safeParse(step).success).toBe(true);
  });

  it("PipelineInput aceita { name, steps } sem id nem datas", () => {
    const input = { name: "Nova", steps: [{ name: "A", model: "sonnet", command: "/a" }] };
    const result = PipelineInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.steps[0]?.interactive).toBe(false);
  });

  it("PipelineInput aplica as mesmas regras (steps vazio e nomes repetidos)", () => {
    expect(issuesOf(PipelineInputSchema.safeParse({ name: "X", steps: [] }))).toContainEqual({
      path: ["steps"],
      message: "A esteira precisa de pelo menos um passo",
    });
    const dup = {
      name: "X",
      steps: [
        { name: "A", model: "sonnet", command: "/a" },
        { name: "A", model: "sonnet", command: "/b" },
      ],
    };
    expect(issuesOf(PipelineInputSchema.safeParse(dup))).toContainEqual({
      path: ["steps", 1, "name"],
      message: "Já existe um passo com este nome",
    });
  });
});

describe("DEFAULT_TIMEOUT_MINUTES", () => {
  it("é 30", () => {
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(30);
  });
});

describe("createDefaultPipeline", () => {
  const pipeline = createDefaultPipeline(NOW);

  it("tem id fixo, nome e isDefault", () => {
    expect(pipeline.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(pipeline.name).toBe("Spec Kit (padrão)");
    expect(pipeline.isDefault).toBe(true);
    expect(pipeline.createdAt).toBe(NOW);
    expect(pipeline.updatedAt).toBe(NOW);
  });

  it("tem os cinco passos da esteira padrão com modelos, interatividade e timeout", () => {
    expect(
      pipeline.steps.map(({ name, command, model, interactive, timeoutMinutes }) => ({
        name,
        command,
        model,
        interactive,
        timeoutMinutes,
      })),
    ).toEqual([
      { name: "Specify", command: "/speckit-specify", model: "sonnet", interactive: false, timeoutMinutes: undefined },
      { name: "Clarify", command: "/speckit-clarify", model: "sonnet", interactive: true, timeoutMinutes: undefined },
      { name: "Plan", command: "/speckit-plan", model: "opus", interactive: false, timeoutMinutes: undefined },
      { name: "Tasks", command: "/speckit-tasks", model: "sonnet", interactive: false, timeoutMinutes: undefined },
      { name: "Implement", command: "/speckit-implement", model: "sonnet", interactive: true, timeoutMinutes: 120 },
    ]);
  });

  it("usa ids de passo fixos e distintos", () => {
    const again = createDefaultPipeline("2030-01-01T00:00:00.000Z");
    expect(again.steps.map((s) => s.id)).toEqual(pipeline.steps.map((s) => s.id));
    expect(new Set(pipeline.steps.map((s) => s.id)).size).toBe(5);
  });
});
