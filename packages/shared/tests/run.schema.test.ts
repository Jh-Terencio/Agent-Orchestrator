import { describe, expect, it } from "vitest";
import { createDefaultPipeline } from "../src/default-pipeline.js";
import { ApiErrorSchema, ReplyRequestSchema, RunSummarySchema, StartRunRequestSchema } from "../src/schemas/api.js";
import { ServerEventSchema } from "../src/schemas/events.js";
import {
  InvocationSchema,
  OutputEntrySchema,
  RepoInfoSchema,
  RunSchema,
  RunStatusSchema,
  SettingsSchema,
  StepRunSchema,
  StepStatusSchema,
  UsageSchema,
} from "../src/schemas/run.js";

const T0 = "2026-11-17T10:00:00.000Z";
const T1 = "2026-11-17T10:05:00.000Z";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 5000,
  cacheCreationTokens: 800,
  costUsd: 0.1309,
  numTurns: 4,
};

const nullUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: null,
  numTurns: null,
};

function invocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "/speckit-specify Adicionar login",
    startedAt: T0,
    finishedAt: T1,
    durationMs: 300000,
    outcome: "success",
    usage,
    sessionCostUsd: 0.1309,
    ...overrides,
  };
}

function stepRun(stepId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepId,
    status: "waiting",
    sessionId: null,
    replies: [],
    invocations: [],
    errorMessage: null,
    interruptReason: null,
    commitSha: null,
    branchAtEnd: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    usage: null,
    ...overrides,
  };
}

function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pipeline = createDefaultPipeline(T0);
  const [first, ...rest] = pipeline.steps;
  return {
    schemaVersion: 1,
    id: RUN_ID,
    pipeline,
    repoPath: "C:/repos/app",
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [
      { ref: "refs/heads/main", sha: "a".repeat(40) },
      { ref: "refs/tags/v1.0", sha: "b".repeat(40) },
    ],
    initialBranch: "orchestrator/20261117-100000-adicionar-login",
    createdBranches: ["orchestrator/20261117-100000-adicionar-login"],
    finalBranch: null,
    status: "awaiting_input",
    startedAt: T0,
    finishedAt: null,
    steps: [
      stepRun(first!.id, {
        status: "completed",
        sessionId: SESSION_ID,
        replies: [{ at: T1, text: "Use OAuth" }],
        invocations: [invocation(), invocation({ prompt: "Use OAuth", outcome: "error", usage: null, sessionCostUsd: null })],
        commitSha: "c".repeat(40),
        branchAtEnd: "orchestrator/20261117-100000-adicionar-login",
        startedAt: T0,
        finishedAt: T1,
        durationMs: 300000,
        usage,
      }),
      ...rest.map((s) => stepRun(s.id)),
    ],
    ...overrides,
  };
}

describe("RunSchema", () => {
  it("aceita um Run válido completo", () => {
    const result = RunSchema.safeParse(validRun());
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("aceita Run terminal com finalBranch e finishedAt", () => {
    expect(RunSchema.safeParse(validRun({ status: "completed", finishedAt: T1, finalBranch: "x" })).success).toBe(true);
  });

  it("rejeita descrição vazia", () => {
    expect(RunSchema.safeParse(validRun({ description: "" })).success).toBe(false);
    expect(RunSchema.safeParse(validRun({ description: "   " })).success).toBe(false);
  });

  it("rejeita schemaVersion diferente de 1", () => {
    expect(RunSchema.safeParse(validRun({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe("RunStatusSchema", () => {
  it.each(["running", "awaiting_input", "completed", "failed", "interrupted"])("aceita %s", (s) => {
    expect(RunStatusSchema.safeParse(s).success).toBe(true);
  });

  it.each(["waiting", "done", ""])("rejeita %s", (s) => {
    expect(RunStatusSchema.safeParse(s).success).toBe(false);
  });
});

describe("StepStatusSchema", () => {
  it.each(["waiting", "running", "awaiting_input", "completed", "failed", "interrupted"])("aceita %s", (s) => {
    expect(StepStatusSchema.safeParse(s).success).toBe(true);
  });

  it.each(["pending", "error", ""])("rejeita %s", (s) => {
    expect(StepStatusSchema.safeParse(s).success).toBe(false);
  });
});

describe("StepRunSchema.interruptReason", () => {
  it.each(["user", "timeout", "server_shutdown", null])("aceita %s", (interruptReason) => {
    expect(StepRunSchema.safeParse(stepRun(RUN_ID, { interruptReason })).success).toBe(true);
  });

  it.each(["crash", ""])("rejeita %s", (interruptReason) => {
    expect(StepRunSchema.safeParse(stepRun(RUN_ID, { interruptReason })).success).toBe(false);
  });
});

describe("OutputEntrySchema.kind", () => {
  it.each(["text", "tool_use", "tool_result", "user_reply", "system", "error"])("aceita %s", (kind) => {
    expect(OutputEntrySchema.safeParse({ seq: 0, at: T0, kind, text: "x" }).success).toBe(true);
  });

  it.each(["stdout", "warning"])("rejeita %s", (kind) => {
    expect(OutputEntrySchema.safeParse({ seq: 0, at: T0, kind, text: "x" }).success).toBe(false);
  });
});

describe("UsageSchema", () => {
  it("aceita todos os campos nulos", () => {
    expect(UsageSchema.safeParse(nullUsage).success).toBe(true);
  });

  it("aceita todos os campos preenchidos", () => {
    expect(UsageSchema.safeParse(usage).success).toBe(true);
  });
});

describe("InvocationSchema", () => {
  it("exige prompt", () => {
    const inv = invocation();
    delete inv.prompt;
    expect(InvocationSchema.safeParse(inv).success).toBe(false);
  });

  it("aceita sessionCostUsd number ou null", () => {
    expect(InvocationSchema.safeParse(invocation({ sessionCostUsd: 0.137 })).success).toBe(true);
    expect(InvocationSchema.safeParse(invocation({ sessionCostUsd: null })).success).toBe(true);
  });

  it("só aceita outcome success/error/interrupted", () => {
    expect(InvocationSchema.safeParse(invocation({ outcome: "interrupted" })).success).toBe(true);
    expect(InvocationSchema.safeParse(invocation({ outcome: "timeout" })).success).toBe(false);
  });
});

describe("RepoInfoSchema e SettingsSchema", () => {
  it("RepoInfo aceita os problemas conhecidos e rejeita outros", () => {
    const base = { path: "C:/r", valid: false, currentBranch: null };
    expect(
      RepoInfoSchema.safeParse({
        ...base,
        problems: ["not_a_repo", "dirty_worktree", "merge_or_rebase_in_progress", "detached_head", "path_not_found"],
      }).success,
    ).toBe(true);
    expect(RepoInfoSchema.safeParse({ ...base, problems: ["other"] }).success).toBe(false);
  });

  it("Settings aceita até 10 recentes e rejeita 11", () => {
    const repos = Array.from({ length: 10 }, (_, i) => `C:/r${i}`);
    expect(SettingsSchema.safeParse({ recentRepos: repos, lastPipelineId: null }).success).toBe(true);
    expect(SettingsSchema.safeParse({ recentRepos: [...repos, "C:/x"], lastPipelineId: null }).success).toBe(false);
  });
});

describe("ServerEventSchema", () => {
  it("discrimina hello / run.updated / step.output / run.finished", () => {
    const run = validRun();
    const events = [
      { type: "hello", activeRun: null },
      { type: "hello", activeRun: run },
      { type: "run.updated", run },
      { type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [{ seq: 1, at: T0, kind: "text", text: "oi" }] },
      { type: "run.finished", run: { ...run, status: "completed", finishedAt: T1, finalBranch: "x" } },
    ];
    for (const event of events) {
      const result = ServerEventSchema.safeParse(event);
      expect(result.success).toBe(true);
      expect(result.data?.type).toBe(event.type);
    }
  });

  it("rejeita type desconhecido e payload incompatível com o type", () => {
    expect(ServerEventSchema.safeParse({ type: "run.deleted", run: validRun() }).success).toBe(false);
    expect(ServerEventSchema.safeParse({ type: "run.updated", activeRun: null }).success).toBe(false);
    expect(ServerEventSchema.safeParse({ type: "step.output", runId: RUN_ID, stepIndex: 0 }).success).toBe(false);
  });
});

describe("RunSummarySchema", () => {
  const summary = {
    id: RUN_ID,
    startedAt: T0,
    repoPath: "C:/repos/app",
    pipelineName: "Spec Kit (padrão)",
    descriptionPreview: "Adicionar login",
    status: "completed",
    finalBranch: "orchestrator/x",
    totalDurationMs: 1000,
    totalUsage: usage,
  };

  it("aceita um resumo válido, inclusive com totais nulos", () => {
    expect(RunSummarySchema.safeParse(summary).success).toBe(true);
    expect(RunSummarySchema.safeParse({ ...summary, totalDurationMs: null, totalUsage: null }).success).toBe(true);
  });

  it("rejeita descriptionPreview com mais de 120 caracteres", () => {
    expect(RunSummarySchema.safeParse({ ...summary, descriptionPreview: "x".repeat(120) }).success).toBe(true);
    expect(RunSummarySchema.safeParse({ ...summary, descriptionPreview: "x".repeat(121) }).success).toBe(false);
  });

  it("exige totalDurationMs e totalUsage (number|null e Usage|null)", () => {
    const { totalDurationMs: _d, ...withoutDuration } = summary;
    const { totalUsage: _u, ...withoutUsage } = summary;
    expect(RunSummarySchema.safeParse(withoutDuration).success).toBe(false);
    expect(RunSummarySchema.safeParse(withoutUsage).success).toBe(false);
  });
});

describe("StartRunRequestSchema", () => {
  const request = {
    repoPath: "C:/repos/app",
    pipelineId: "00000000-0000-4000-8000-000000000001",
    description: "Adicionar login",
    expectedBranch: "main",
  };

  it("aceita uma requisição válida", () => {
    expect(StartRunRequestSchema.safeParse(request).success).toBe(true);
  });

  it("exige expectedBranch não vazio", () => {
    const { expectedBranch: _b, ...without } = request;
    expect(StartRunRequestSchema.safeParse(without).success).toBe(false);
    expect(StartRunRequestSchema.safeParse({ ...request, expectedBranch: "" }).success).toBe(false);
  });

  it("rejeita descrição vazia após trim", () => {
    expect(StartRunRequestSchema.safeParse({ ...request, description: "  \n " }).success).toBe(false);
  });
});

describe("ReplyRequestSchema", () => {
  it("exige text não vazio", () => {
    expect(ReplyRequestSchema.safeParse({ text: "sim" }).success).toBe(true);
    expect(ReplyRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(ReplyRequestSchema.safeParse({ text: "   " }).success).toBe(false);
  });
});

describe("ApiErrorSchema", () => {
  it("aceita os códigos do contrato com issues e details opcionais", () => {
    const codes = [
      "VALIDATION_FAILED",
      "NOT_FOUND",
      "RUN_ALREADY_ACTIVE",
      "INVALID_STATE",
      "BRANCH_CHANGED",
      "REPO_REJECTED",
      "PIPELINE_INVALID",
      "FORBIDDEN_ORIGIN",
    ];
    for (const code of codes) {
      expect(ApiErrorSchema.safeParse({ error: { code, message: "m" } }).success).toBe(true);
    }
    expect(
      ApiErrorSchema.safeParse({
        error: {
          code: "VALIDATION_FAILED",
          message: "m",
          issues: [{ path: ["steps", 0, "command"], message: "Obrigatório" }],
          details: { currentBranch: "dev" },
        },
      }).success,
    ).toBe(true);
  });

  it("rejeita código desconhecido", () => {
    expect(ApiErrorSchema.safeParse({ error: { code: "BOOM", message: "m" } }).success).toBe(false);
  });
});
