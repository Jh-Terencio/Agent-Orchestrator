import type { ErrorRequestHandler, RequestHandler } from "express";
import type { ApiErrorCode, ApiError as ApiErrorBody, ApiIssue } from "@orchestrator/shared";
import type { z } from "zod";

/** Erro com status HTTP e `code` de contracts/rest-api.md. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: ApiIssue[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    issues?: ApiIssue[],
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues === undefined ? {} : { issues: this.issues }),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Issues do Zod no formato `{ path, message }` da API. */
export function toApiIssues(error: z.ZodError): ApiIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((key): key is string | number => typeof key !== "symbol"),
    message: issue.message,
  }));
}

/** Corpo ou parâmetro inválido → `400 VALIDATION_FAILED` com as issues. */
export function fromZodError(error: z.ZodError, message = "Dados inválidos"): ApiError {
  return new ApiError(400, "VALIDATION_FAILED", message, toApiIssues(error));
}

/** Rota inexistente sob `/api`. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, "NOT_FOUND", "Rota não encontrada"));
};

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError && "type" in error && error.type === "entity.parse.failed";
}

/** Serializa qualquer erro no formato `{ error: { code, message, issues?, details? } }`. */
export const errorMiddleware: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (isJsonSyntaxError(error)) {
    apiError = new ApiError(400, "VALIDATION_FAILED", "O corpo da requisição não é um JSON válido");
  } else {
    console.error("[http] erro inesperado:", error);
    const message = error instanceof Error ? error.message : String(error);
    apiError = new ApiError(500, "INTERNAL_ERROR", `Erro inesperado no servidor: ${message}`);
  }
  res.status(apiError.status).json(apiError.toBody());
};
