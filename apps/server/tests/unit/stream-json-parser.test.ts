import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OutputEntry } from "@orchestrator/shared";
import { AUTH_ERROR_MESSAGE, createStreamJsonParser } from "../../src/agent/stream-json-parser.js";

type Entry = Omit<OutputEntry, "seq" | "at">;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "stream-json");
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");

// Valores das fixtures capturadas (README.md da pasta de fixtures).
const SUCCESS_COST = 0.00463959;
const RESUME_INVOCATION_COST = 0.00023752;
const RESUME_SESSION_COST = 0.00487711;

function parse(input: string | Buffer[], priorSessionCostUsd: number | null = 0) {
  const entries: Entry[] = [];
  const parser = createStreamJsonParser({ onOutput: (entry) => entries.push(entry), priorSessionCostUsd });
  const chunks = typeof input === "string" ? [Buffer.from(input, "utf8")] : input;
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return { entries, result: parser.getResult() };
}

/** Remove `model_usage_since_last_result` do `result` (simula versões da CLI que não o reportam). */
function withoutSinceLast(jsonl: string): string {
  return jsonl
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") delete event.model_usage_since_last_result;
      return JSON.stringify(event);
    })
    .join("\n");
}

describe("stream-json-parser: fixtures reais", () => {
  it("system init → entrada system com modelo e sessão", () => {
    const { entries } = parse(fixture("success"));
    expect(entries[0]).toEqual({
      kind: "system",
      text: "modelo claude-haiku-5-5, sessão 00000000-0000-4000-8000-000000000001",
    });
  });

  it("tool_use → '<Ferramenta>: <resumo>' e tool_result → tool_result", () => {
    const { entries } = parse(fixture("success"));
    expect(entries).toContainEqual({ kind: "tool_use", text: "Read: /repo/README.md" });
    const toolResult = entries.find((entry) => entry.kind === "tool_result");
    expect(toolResult?.text).toContain("Este repositório é só um exemplo de configuração.");
  });

  it("deltas de texto viram text, sem duplicar o bloco text do assistant", () => {
    const { entries, result } = parse(fixture("success"));
    const text = entries
      .filter((entry) => entry.kind === "text")
      .map((entry) => entry.text)
      .join("");
    expect(text).toBe("O README.md descreve o repositório como um simples exemplo de configuração.");
    expect(result?.message).toBe(text);
  });

  it("result sem erro → success com Usage mapeado e sessionCostUsd bruto", () => {
    const { result } = parse(fixture("success"), 0);
    expect(result).toMatchObject({
      isError: false,
      sessionId: "00000000-0000-4000-8000-000000000001",
      sessionCostUsd: SUCCESS_COST,
      usage: {
        inputTokens: 4,
        outputTokens: 112,
        cacheReadTokens: 21679,
        cacheCreationTokens: 21832,
        numTurns: 2,
      },
    });
    expect(result?.usage?.costUsd).toBeCloseTo(SUCCESS_COST, 10);
  });

  it("result com is_error → error com a mensagem do result", () => {
    const { result } = parse(fixture("error-result"));
    expect(result?.isError).toBe(true);
    expect(result?.message).toContain("modelo-que-nao-existe");
  });

  it("auth-error → error com a mensagem acionável de login", () => {
    const { result } = parse(fixture("auth-error"));
    expect(result?.isError).toBe(true);
    expect(result?.message).toBe(AUTH_ERROR_MESSAGE);
    expect(AUTH_ERROR_MESSAGE).toContain("Rode `claude` num terminal e faça `/login`");
  });

  it("passo que termina com pergunta → success com o texto da pergunta", () => {
    const { entries, result } = parse(fixture("question-ending"));
    expect(result?.isError).toBe(false);
    expect(entries.filter((e) => e.kind === "text").map((e) => e.text).join("")).toBe(
      "Qual nome você quer dar à feature?",
    );
  });
});

describe("stream-json-parser: custo por invocação (research R1)", () => {
  it("com model_usage_since_last_result, costUsd é o da invocação e não o acumulado", () => {
    const { result } = parse(fixture("resume"), SUCCESS_COST);
    expect(result?.usage?.costUsd).toBeCloseTo(RESUME_INVOCATION_COST, 10);
    expect(result?.sessionCostUsd).toBe(RESUME_SESSION_COST);
    expect(result?.usage).toMatchObject({ inputTokens: 2, outputTokens: 10, numTurns: 1 });
  });

  it("model_usage_since_last_result não depende de priorSessionCostUsd", () => {
    const { result } = parse(fixture("resume"), null);
    expect(result?.usage?.costUsd).toBeCloseTo(RESUME_INVOCATION_COST, 10);
  });

  it("sem model_usage_since_last_result, costUsd = total_cost_usd − priorSessionCostUsd", () => {
    const { result } = parse(withoutSinceLast(fixture("resume")), SUCCESS_COST);
    expect(result?.usage?.costUsd).toBeCloseTo(RESUME_SESSION_COST - SUCCESS_COST, 10);
  });

  it("sem model_usage_since_last_result e priorSessionCostUsd null → costUsd null", () => {
    const { result } = parse(withoutSinceLast(fixture("resume")), null);
    expect(result?.usage?.costUsd).toBeNull();
    expect(result?.sessionCostUsd).toBe(RESUME_SESSION_COST);
  });

  it("na 1ª invocação (priorSessionCostUsd 0) sem model_usage_since_last_result, costUsd = total_cost_usd", () => {
    const { result } = parse(withoutSinceLast(fixture("success")), 0);
    expect(result?.usage?.costUsd).toBeCloseTo(SUCCESS_COST, 10);
  });

  it("success + resume somam o total_cost_usd final da sessão", () => {
    const first = parse(fixture("success"), 0).result;
    const second = parse(fixture("resume"), first?.sessionCostUsd ?? null).result;
    expect((first?.usage?.costUsd ?? 0) + (second?.usage?.costUsd ?? 0)).toBeCloseTo(RESUME_SESSION_COST, 10);
  });
});

describe("stream-json-parser: tolerância", () => {
  const ignored = [
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "system", subtype: "status", status: "requesting" },
    { type: "system", subtype: "hook_started" },
    { type: "system", subtype: "hook_response" },
    { type: "system", subtype: "hook_progress" },
    { type: "stream_event", event: { type: "message_start", message: {} } },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } },
    },
    { type: "tipo_inventado_do_futuro", foo: 1 },
  ];

  it.each(ignored.map((event) => [event.type + ("subtype" in event ? `:${String(event.subtype)}` : ""), event]))(
    "%s é ignorado sem lançar e sem gerar saída",
    (_label, event) => {
      const { entries, result } = parse(`${JSON.stringify(event)}\n`);
      expect(entries).toEqual([]);
      expect(result).toBeNull();
    },
  );

  it("linha não JSON é ignorada sem lançar", () => {
    const { entries } = parse("isto não é json\n{quebrado\n");
    expect(entries).toEqual([]);
  });

  it("linha quebrada em dois chunks é remontada", () => {
    const line = JSON.stringify(textDelta("olá mundo"));
    const { entries } = parse([Buffer.from(line.slice(0, 20)), Buffer.from(`${line.slice(20)}\n`)]);
    expect(entries).toEqual([{ kind: "text", text: "olá mundo" }]);
  });

  it("\\r\\n é aceito como fim de linha", () => {
    const { entries } = parse(`${JSON.stringify(textDelta("a"))}\r\n${JSON.stringify(textDelta("b"))}\r\n`);
    expect(entries.map((entry) => entry.text).join("")).toBe("ab");
  });

  it("última linha sem \\n é processada no end()", () => {
    const { entries } = parse(JSON.stringify(textDelta("fim")));
    expect(entries).toEqual([{ kind: "text", text: "fim" }]);
  });

  it("caractere UTF-8 cortado entre dois chunks é decodificado corretamente", () => {
    const bytes = Buffer.from(`${JSON.stringify(textDelta("café"))}\n`, "utf8");
    const cut = bytes.indexOf(0xc3) + 1; // entre 0xC3 e 0xA9
    expect(bytes[cut]).toBe(0xa9);
    const { entries } = parse([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(entries).toEqual([{ kind: "text", text: "café" }]);
    expect(entries[0]?.text).not.toMatch(/�|Ã©/);
  });

  it("fixture inteira entregue byte a byte gera a mesma saída", () => {
    const whole = parse(fixture("success"));
    const bytes = Buffer.from(fixture("success"), "utf8");
    const byByte = parse(Array.from(bytes, (byte) => Buffer.from([byte])));
    expect(byByte.entries.map((e) => e.text).join("")).toBe(whole.entries.map((e) => e.text).join(""));
    expect(byByte.result).toEqual(whole.result);
  });
});

function textDelta(text: string) {
  return { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
}
