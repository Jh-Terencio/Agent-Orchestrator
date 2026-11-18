import { z } from "zod";
import { PipelineSchema } from "./pipeline.js";

const nonBlank = (message: string) => z.string().refine((value) => value.trim().length > 0, message);

export const RunStatusSchema = z.enum([
  "running",
  "awaiting_input",
  "awaiting_permission",
  "completed",
  "failed",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  "waiting",
  "running",
  "awaiting_input",
  "awaiting_permission",
  "completed",
  "failed",
  "interrupted",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const InterruptReasonSchema = z.enum(["user", "timeout", "server_shutdown"]);
export type InterruptReason = z.infer<typeof InterruptReasonSchema>;

const count = z.number().int().nonnegative().nullable();

/** Consumo de uma invocação (ou soma delas). Campos nulos quando a CLI não os reporta (FR-016). */
export const UsageSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheCreationTokens: count,
  costUsd: z.number().nonnegative().nullable(),
  numTurns: count,
});
export type Usage = z.infer<typeof UsageSchema>;

export const InvocationOutcomeSchema = z.enum(["success", "error", "interrupted"]);
export type InvocationOutcome = z.infer<typeof InvocationOutcomeSchema>;

export const InvocationSchema = z.object({
  /** Texto exato enviado ao agente nesta invocação: a entrada do passo (FR-016). */
  prompt: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  outcome: InvocationOutcomeSchema,
  /** Consumo só desta invocação. */
  usage: UsageSchema.nullable(),
  /** `total_cost_usd` bruto, acumulado na sessão; base para a próxima diferença (research R1). */
  sessionCostUsd: z.number().nonnegative().nullable(),
});
export type Invocation = z.infer<typeof InvocationSchema>;

export const ReplySchema = z.object({
  at: z.iso.datetime(),
  text: z.string(),
});
export type Reply = z.infer<typeof ReplySchema>;

export const PermissionRequestStatusSchema = z.enum([
  "pending",
  "allowed_once",
  "allowed_always",
  "denied",
  /** Casou com uma regra de `Run.permissionRules`: aprovado na hora, sem pausar. */
  "auto_allowed",
  /** Interrupção, encerramento ou desistência da CLI. */
  "cancelled",
]);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

/** Pedido de permissão do agente (FR-028–FR-031, research R13). */
export const PermissionRequestSchema = z.object({
  id: z.uuid(),
  /** Id da chamada de ferramenta na CLI. */
  toolUseId: z.string(),
  toolName: z.string(),
  /** Entrada bruta da ferramenta (ex.: `{ command, description }`). */
  input: z.record(z.string(), z.unknown()),
  /** Texto exibido, no formato do `tool_use` (ex.: "Bash: npm test"). */
  summary: z.string(),
  status: PermissionRequestStatusSchema,
  /** Regra criada por "permitir sempre". */
  rule: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const StepRunSchema = z.object({
  stepId: z.uuid(),
  status: StepStatusSchema,
  sessionId: z.uuid().nullable(),
  replies: z.array(ReplySchema),
  invocations: z.array(InvocationSchema),
  errorMessage: z.string().nullable(),
  interruptReason: InterruptReasonSchema.nullable(),
  commitSha: z.string().nullable(),
  branchAtEnd: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  usage: UsageSchema.nullable(),
  /** Pedidos de permissão do passo, em ordem (US6); `.default` para `run.json` antigos. */
  permissionRequests: z.array(PermissionRequestSchema).default([]),
});
export type StepRun = z.infer<typeof StepRunSchema>;

export const RefEntrySchema = z.object({
  ref: z.string().min(1),
  sha: z.string().min(1),
});
export type RefEntry = z.infer<typeof RefEntrySchema>;

export const RunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  /** Cópia da definição da esteira no momento do envio (Princípio IV). */
  pipeline: PipelineSchema,
  repoPath: z.string().min(1),
  description: nonBlank("Descreva a feature"),
  sourceBranch: z.string().min(1),
  refSnapshot: z.array(RefEntrySchema),
  initialBranch: z.string().min(1),
  createdBranches: z.array(z.string()),
  finalBranch: z.string().nullable(),
  status: RunStatusSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  steps: z.array(StepRunSchema),
  /** Modo Yolo escolhido no envio (FR-027); `.default` para `run.json` antigos. */
  yolo: z.boolean().default(false),
  /** Regras de "permitir sempre nesta execução" (FR-029), ex.: `Bash(npm test:*)`. */
  permissionRules: z.array(z.string()).default([]),
});
export type Run = z.infer<typeof RunSchema>;

export const OutputKindSchema = z.enum(["text", "tool_use", "tool_result", "user_reply", "system", "error"]);
export type OutputKind = z.infer<typeof OutputKindSchema>;

export const OutputEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  kind: OutputKindSchema,
  text: z.string(),
});
export type OutputEntry = z.infer<typeof OutputEntrySchema>;

export const RepoProblemSchema = z.enum([
  "not_a_repo",
  "dirty_worktree",
  "merge_or_rebase_in_progress",
  "detached_head",
  "path_not_found",
]);
export type RepoProblem = z.infer<typeof RepoProblemSchema>;

export const RepoInfoSchema = z.object({
  path: z.string(),
  valid: z.boolean(),
  currentBranch: z.string().nullable(),
  problems: z.array(RepoProblemSchema),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const SettingsSchema = z.object({
  /** Mais recente primeiro, no máximo 10. */
  recentRepos: z.array(z.string()).max(10),
  lastPipelineId: z.uuid().nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;
