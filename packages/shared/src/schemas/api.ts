import { z } from "zod";
import { RunStatusSchema, UsageSchema } from "./run.js";

/** DTOs REST (contracts/rest-api.md). */

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "RUN_ALREADY_ACTIVE",
  "INVALID_STATE",
  "BRANCH_CHANGED",
  "REPO_REJECTED",
  "PIPELINE_INVALID",
  "FORBIDDEN_ORIGIN",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type ApiIssue = z.infer<typeof ApiIssueSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    issues: z.array(ApiIssueSchema).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const StartRunRequestSchema = z.object({
  repoPath: z.string().min(1, "Informe o repositório"),
  pipelineId: z.uuid(),
  description: z.string().refine((value) => value.trim().length > 0, "Descreva a feature antes de enviar"),
  expectedBranch: z.string().min(1, "Informe a branch esperada"),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const ReplyRequestSchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0, "Escreva uma resposta"),
});
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;

export const RunSummarySchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  repoPath: z.string(),
  pipelineName: z.string(),
  descriptionPreview: z.string().max(120),
  status: RunStatusSchema,
  finalBranch: z.string().nullable(),
  totalDurationMs: z.number().nonnegative().nullable(),
  totalUsage: UsageSchema.nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
