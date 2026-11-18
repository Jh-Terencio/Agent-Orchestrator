import {
  ApiErrorSchema,
  type ApiErrorCode,
  type ApiIssue,
  type OutputEntry,
  type Pipeline,
  type PipelineInput,
  type RepoInfo,
  type Run,
  type RunSummary,
  type Settings,
  type StartRunRequest,
} from "@orchestrator/shared";

/** Erro devolvido pela API no formato `{ error: { code, message, issues?, details? } }`. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK_ERROR" | "UNEXPECTED_RESPONSE",
    message: string,
    readonly issues: ApiIssue[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const BASE = "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiClientError(0, "NETWORK_ERROR", `Não foi possível falar com o servidor do orquestrador (${detail}).`);
  }

  if (response.status === 202 || response.status === 204) return undefined as T;

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, issues, details } = parsed.data.error;
      throw new ApiClientError(response.status, code, message, issues ?? [], details ?? {});
    }
    throw new ApiClientError(response.status, "UNEXPECTED_RESPONSE", `Resposta inesperada do servidor (HTTP ${response.status}).`);
  }
  return json as T;
}

const enc = encodeURIComponent;

// Repositórios e preferências
export const inspectRepo = (path: string): Promise<RepoInfo> => request("GET", `/repos/inspect?path=${enc(path)}`);
export const getSettings = (): Promise<Settings> => request("GET", "/settings");

// Esteiras
export const listPipelines = (): Promise<Pipeline[]> => request("GET", "/pipelines");
export const getPipeline = (id: string): Promise<Pipeline> => request("GET", `/pipelines/${enc(id)}`);
export const createPipeline = (input: PipelineInput): Promise<Pipeline> => request("POST", "/pipelines", input);
export const updatePipeline = (id: string, input: PipelineInput): Promise<Pipeline> =>
  request("PUT", `/pipelines/${enc(id)}`, input);
export const duplicatePipeline = (id: string): Promise<Pipeline> => request("POST", `/pipelines/${enc(id)}/duplicate`);
export const deletePipeline = (id: string): Promise<void> => request("DELETE", `/pipelines/${enc(id)}`);

// Execuções
export const startRun = (body: StartRunRequest): Promise<Run> => request("POST", "/runs", body);
/** `null` quando não há execução ativa (204). */
export const getActiveRun = async (): Promise<Run | null> => (await request<Run | undefined>("GET", "/runs/active")) ?? null;
export const getRun = (id: string): Promise<Run> => request("GET", `/runs/${enc(id)}`);
export const listRuns = (): Promise<RunSummary[]> => request("GET", "/runs");
export const getStepOutput = (runId: string, index: number, afterSeq?: number): Promise<OutputEntry[]> =>
  request(
    "GET",
    `/runs/${enc(runId)}/steps/${index}/output${afterSeq === undefined ? "" : `?afterSeq=${afterSeq}`}`,
  );
export const reply = (runId: string, text: string): Promise<void> => request("POST", `/runs/${enc(runId)}/reply`, { text });
export const advance = (runId: string): Promise<void> => request("POST", `/runs/${enc(runId)}/advance`);
export const interrupt = (runId: string): Promise<void> => request("POST", `/runs/${enc(runId)}/interrupt`);
