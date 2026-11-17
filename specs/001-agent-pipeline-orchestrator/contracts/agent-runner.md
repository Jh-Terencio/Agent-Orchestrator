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
  priorSessionCostUsd: number | null; // total_cost_usd bruto da invocação anterior da mesma sessão; 0 quando resume = false; null se desconhecido (research R1)
  signal: AbortSignal;      // AbortController do executor; reason = "user" | "timeout" | "server_shutdown"
  onOutput: (entry: Omit<OutputEntry, "seq" | "at">) => void;
}

// usage.costUsd é o custo desta invocação (não o acumulado da sessão).
// sessionCostUsd é o total_cost_usd bruto do result (acumulado na sessão), guardado para calcular a próxima diferença.
export type AgentOutcome =
  | { kind: "success"; usage: Usage | null; sessionCostUsd: number | null; durationMs: number }
  | { kind: "error"; message: string; usage: Usage | null; sessionCostUsd: number | null; durationMs: number }
  | { kind: "interrupted"; usage: Usage | null; sessionCostUsd: number | null; durationMs: number };

export interface AgentRunner {
  run(invocation: AgentInvocation): Promise<AgentOutcome>; // nunca rejeita; erros viram { kind: "error" }
}
```

## Garantias exigidas de qualquer implementação

1. `run` **resolve** em até 5 s depois de `signal` ser abortado, com `kind: "interrupted"`, e não deixa processos vivos (SC-005).
2. `onOutput` é chamado em ordem e nunca depois que a Promise resolve.
3. Falhas de ambiente (binário ausente, sem login, modelo inválido, skill inexistente) viram `kind: "error"` com `message` acionável. Exemplos: "Claude Code não encontrado no PATH. Instale e rode `claude` uma vez para fazer login."; para `result` com erro de autenticação: "Claude Code não está autenticado. Rode `claude` num terminal e faça `/login` com a sua assinatura."

## Resolução do executável (`agent/resolve-claude.ts`)

`resolveClaudeCommand({ platform, pathEnv, pathExt, exists, readFile }) → { command: string; prefixArgs: string[] } | { error: string }`, função pura (I/O injetado) chamada pelo `ClaudeCliRunner` antes do `spawn`. **Nunca usa `shell: true`**: o prompt contém texto livre do usuário, e passar por um shell abriria injeção de comandos e problemas de aspas. O Node também recusa `spawn` de `.cmd`/`.bat` sem shell (EINVAL).

| Plataforma | Encontrado no `PATH` | Resultado |
|---|---|---|
| win32 | `claude.exe` (instalador nativo) | `{ command: "<caminho>\\claude.exe", prefixArgs: [] }`, **preferido** mesmo que também exista `claude.cmd` |
| win32 | só `claude.cmd` (instalação via npm) | lê o shim e resolve o `cli.js` do pacote (`<dir do shim>\node_modules\@anthropic-ai\claude-code\cli.js`, conforme o caminho referenciado no `.cmd`); se o arquivo existir → `{ command: process.execPath, prefixArgs: ["<cli.js>"] }` |
| win32 | `claude.cmd` sem `cli.js` resolvível | `{ error: "Encontrei claude.cmd, mas não consegui localizar o cli.js do Claude Code. Reinstale com o instalador nativo (claude.exe)." }` |
| win32 | nenhum | `{ error: "Claude Code não encontrado no PATH. Instale e rode `claude` uma vez para fazer login." }` |
| outras | `claude` | `{ command: "claude", prefixArgs: [] }` (o `ENOENT` no spawn vira o mesmo erro acionável) |

O `error` resolvido vira `kind: "error"` sem iniciar processo.

## `ClaudeCliRunner`: mapeamento para a CLI

```text
<command> <prefixArgs...> -p <prompt>          # <command>/<prefixArgs> vêm de resolveClaudeCommand
  --output-format stream-json --verbose --include-partial-messages
  --model <model>
  (--session-id <sessionId> | --resume <sessionId>)
  --permission-mode acceptEdits
  --setting-sources project,local --strict-mcp-config   # sempre; isola a configuração pessoal (research R3a)
  --allowedTools ... --disallowedTools ...      # constante em agent/permissions.ts (research R3)
  [--append-system-prompt <NON_INTERACTIVE_SYSTEM_PROMPT>]   # só quando interactive = false (research R2a)
cwd = invocation.cwd ; stdin = ignore ; detached = (plataforma ≠ win32)
```

**Decodificação**: stdout e stderr são lidos como `Buffer` e decodificados por um `StringDecoder("utf8")` antes de separar as linhas, para que um caractere multibyte dividido entre dois chunks não seja corrompido (research R10). As linhas são separadas por `\n`, com `\r` final removido; uma linha incompleta fica no buffer até o chunk seguinte (ou até o fim do stream).

O limite de tempo **não** é responsabilidade do runner. O executor cria um `AbortController` por invocação e agenda `setTimeout(() => controller.abort("timeout"), ms)` (research R4). Isso mantém o tempo controlável por *fake timers* do Vitest. O runner só reage ao `signal`.

| Linha stream-json | Ação |
|---|---|
| `stream_event` com `content_block_delta`/`text_delta` | `onOutput({ kind: "text", text })` |
| `assistant` com `tool_use` | `onOutput({ kind: "tool_use", text: "<Ferramenta>: <resumo>" })`; blocos `text` do `assistant` são ignorados (já vieram pelos deltas) |
| `user` com `tool_result` | `onOutput({ kind: "tool_result", text })` |
| `system` com `subtype: "init"` | `onOutput({ kind: "system", text: "modelo X, sessão Y" })` |
| `result` | define o resultado: `is_error` → `error` (mensagem = `result`/`subtype`), senão `success`. `Usage` = tokens de `usage` (da invocação) + `num_turns` + `costUsd` calculado pela regra de research R1: soma de `model_usage_since_last_result[*].costUSD`; na falta dele, `total_cost_usd − priorSessionCostUsd`; `null` se `priorSessionCostUsd` for `null`. `sessionCostUsd` = `total_cost_usd` bruto |
| tipo ignorado: `rate_limit_event`, `system` com outro `subtype` (`status`, `hook_started`, `hook_response`, `hook_progress`...), `stream_event` sem `text_delta` (`input_json_delta`, `message_start`...), qualquer `type` desconhecido | nenhuma ação, sem lançar |
| linha não JSON | ignorada, sem lançar |
| saída ≠ 0 sem `result` | `error` com as últimas linhas de stderr |
| `ENOENT` no spawn | `error` "Claude Code não encontrado..." |

## `FakeAgentRunner` (testes)

Roteiro programável por chamada: emite N `onOutput`, executa um `sideEffect?: (cwd: string) => Promise<void>` opcional (para simular o trabalho do agente no repositório: escrever arquivos, `git switch -c`, trocar para uma branch pré-existente, criar tag), espera um atraso (com *fake timers*) e resolve com o resultado configurado. O `sideEffect` roda antes de resolver e também quando a chamada é interrompida (simula alterações parciais). Respeita `signal` e registra as invocações recebidas para asserções (modelo, `resume`, `interactive`, `sessionId`, `priorSessionCostUsd`, prompt). O resultado configurado pode incluir `sessionCostUsd`.
