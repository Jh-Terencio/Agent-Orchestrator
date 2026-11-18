import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentInvocation, AgentOutcome, AgentRunner } from "./agent-runner.js";
import { buildClaudeArgs } from "./permissions.js";
import { CLAUDE_NOT_FOUND_MESSAGE, resolveClaudeCommand, systemResolveDeps, type ResolvedClaude } from "./resolve-claude.js";
import { createStreamJsonParser } from "./stream-json-parser.js";

const STDERR_TAIL_LINES = 20;

export interface ClaudeCliRunnerOptions {
  /** Resolução do executável; padrão: `resolveClaudeCommand(systemResolveDeps())`. */
  resolveCommand?: () => ResolvedClaude;
}

/**
 * `AgentRunner` de produção: roda `claude -p ... --output-format stream-json` como processo filho,
 * sem shell (contracts/agent-runner.md). Nunca rejeita: falhas viram `{ kind: "error" }`.
 * O tratamento de `signal` (encerrar a árvore de processos) chega em US3.
 */
export class ClaudeCliRunner implements AgentRunner {
  private readonly resolveCommand: () => ResolvedClaude;

  constructor(options: ClaudeCliRunnerOptions = {}) {
    this.resolveCommand = options.resolveCommand ?? (() => resolveClaudeCommand(systemResolveDeps()));
  }

  run(invocation: AgentInvocation): Promise<AgentOutcome> {
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;

    let resolved: ResolvedClaude;
    try {
      resolved = this.resolveCommand();
    } catch (error) {
      resolved = { error: error instanceof Error ? error.message : String(error) };
    }
    if ("error" in resolved) {
      return Promise.resolve({ kind: "error", message: resolved.error, usage: null, sessionCostUsd: null, durationMs: 0 });
    }

    return new Promise<AgentOutcome>((resolve) => {
      let settled = false;
      const parser = createStreamJsonParser({
        onOutput: (entry) => {
          if (!settled) invocation.onOutput(entry);
        },
        priorSessionCostUsd: invocation.priorSessionCostUsd,
      });
      const stderrDecoder = new StringDecoder("utf8");
      let stderr = "";

      const finish = (outcome: AgentOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      let child;
      try {
        child = spawn(resolved.command, [...resolved.prefixArgs, ...buildClaudeArgs(invocation)], {
          cwd: invocation.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        finish(spawnFailure(error, elapsed()));
        return;
      }

      // Sem setEncoding: os Buffers vão direto ao parser, que decodifica com StringDecoder (research R10).
      child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = tailLines(stderr + stderrDecoder.write(chunk));
      });

      child.on("error", (error) => finish(spawnFailure(error, elapsed())));
      child.on("close", (code) => {
        parser.end();
        stderr = tailLines(stderr + stderrDecoder.end());
        const result = parser.getResult();
        const durationMs = elapsed();
        if (result) {
          const base = { usage: result.usage, sessionCostUsd: result.sessionCostUsd, durationMs };
          finish(
            result.isError
              ? { kind: "error", message: result.message ?? "O agente terminou com erro", ...base }
              : { kind: "success", ...base },
          );
          return;
        }
        const detail = stderr.trim();
        finish({
          kind: "error",
          message: detail
            ? `O Claude Code terminou sem resultado (código ${code ?? "?"}): ${detail}`
            : `O Claude Code terminou sem resultado (código ${code ?? "?"}).`,
          usage: null,
          sessionCostUsd: null,
          durationMs,
        });
      });
    });
  }
}

function tailLines(text: string): string {
  const lines = text.split("\n");
  return lines.length > STDERR_TAIL_LINES ? lines.slice(-STDERR_TAIL_LINES).join("\n") : text;
}

function spawnFailure(error: unknown, durationMs: number): AgentOutcome {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const message =
    code === "ENOENT"
      ? CLAUDE_NOT_FOUND_MESSAGE
      : `Não foi possível iniciar o Claude Code: ${error instanceof Error ? error.message : String(error)}`;
  return { kind: "error", message, usage: null, sessionCostUsd: null, durationMs };
}
