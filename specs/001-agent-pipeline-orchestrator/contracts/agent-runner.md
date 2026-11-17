# Contrato interno: `AgentRunner`

Fronteira entre o executor da esteira e a ferramenta de agente (research R1). O executor depende **apenas** desta interface. Os testes usam `FakeAgentRunner`, e a produção usa `ClaudeCliRunner`.

```ts
// apps/server/src/agent/agent-runner.ts
export interface AgentInvocation {
  cwd: string;              // repositório alvo
  prompt: string;           // ex.: "/speckit-specify <descrição>" ou a resposta do usuário
  model: string;            // alias ou id completo
  sessionId: string;        // uuid; nova sessão na 1ª chamada
  resume: boolean;          // true → continua sessionId (resposta de passo interativo)
  interactive: boolean;     // false → instrui o agente a não fazer perguntas (FR-006a)
  signal: AbortSignal;      // AbortController do executor; reason = "user" | "timeout" | "server_shutdown"
  onOutput: (entry: Omit<OutputEntry, "seq" | "at">) => void;
}

export type AgentOutcome =
  | { kind: "success"; usage: Usage | null; durationMs: number }
  | { kind: "error"; message: string; usage: Usage | null; durationMs: number }
  | { kind: "interrupted"; usage: Usage | null; durationMs: number };

export interface AgentRunner {
  run(invocation: AgentInvocation): Promise<AgentOutcome>; // nunca rejeita; erros viram { kind: "error" }
}
```

## Garantias exigidas de qualquer implementação

1. `run` **resolve** em até 5 s depois de `signal` ser abortado, com `kind: "interrupted"`, e não deixa processos vivos (SC-005).
2. `onOutput` é chamado em ordem e nunca depois que a Promise resolve.
3. Falhas de ambiente (binário ausente, sem login, modelo inválido, skill inexistente) viram `kind: "error"` com `message` acionável. Exemplo: "Claude Code não encontrado no PATH. Instale e rode `claude` uma vez para fazer login."

## `ClaudeCliRunner`: mapeamento para a CLI

```text
claude -p <prompt>
  --output-format stream-json --verbose --include-partial-messages
  --model <model>
  (--session-id <sessionId> | --resume <sessionId>)
  --permission-mode acceptEdits
  --allowedTools ... --disallowedTools ...      # constante em agent/permissions.ts (research R3)
  [--append-system-prompt <NON_INTERACTIVE_SYSTEM_PROMPT>]   # só quando interactive = false (research R2a)
cwd = invocation.cwd ; stdin = ignore ; detached = (plataforma ≠ win32)
```

O limite de tempo **não** é responsabilidade do runner. O executor cria um `AbortController` por invocação e agenda `setTimeout(() => controller.abort("timeout"), ms)` (research R4). Isso mantém o tempo controlável por *fake timers* do Vitest. O runner só reage ao `signal`.

| Linha stream-json | Ação |
|---|---|
| `stream_event` com delta de texto | `onOutput({ kind: "text", text })` |
| `assistant` com `tool_use` | `onOutput({ kind: "tool_use", text: "<Ferramenta>: <resumo>" })` |
| `user` com `tool_result` | `onOutput({ kind: "tool_result", text })` |
| `system` (init) | `onOutput({ kind: "system", text: "modelo X, sessão Y" })` |
| `result` | define o resultado: `is_error` → `error` (mensagem = `result`/`subtype`), senão `success`; `usage` + `total_cost_usd` → `Usage` |
| saída ≠ 0 sem `result` | `error` com as últimas linhas de stderr |
| `ENOENT` no spawn | `error` "Claude Code não encontrado..." |

## `FakeAgentRunner` (testes)

Roteiro programável por chamada: emite N `onOutput`, espera um atraso (com *fake timers*) e resolve com o resultado configurado. Respeita `signal` e registra as invocações recebidas para asserções (modelo, `resume`, `interactive`, `sessionId`, prompt).
