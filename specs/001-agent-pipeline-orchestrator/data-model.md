# Phase 1 — Data Model

**Feature**: `001-agent-pipeline-orchestrator` | Fonte: [spec.md](./spec.md) · [research.md](./research.md)

Todos os schemas vivem em `packages/shared/src/schemas/` (Zod), e os tipos são derivados com `z.infer`.
Identificadores são UUID v4 (`crypto.randomUUID()`). Datas são strings ISO-8601 em UTC.

---

## 1. Pipeline (Esteira): `pipelines/<id>.json`

| Campo | Tipo | Regras |
|---|---|---|
| `schemaVersion` | `1` (literal) | obrigatório; permite migrações futuras |
| `id` | uuid | obrigatório; igual ao nome do arquivo |
| `name` | string | obrigatório, 1–80 caracteres após `trim`, único entre as esteiras salvas (validação no servidor) |
| `isDefault` | boolean | `true` só na esteira padrão do Spec Kit (FR-020) |
| `steps` | `Step[]` | **mínimo 1** passo (FR-024) |
| `createdAt` / `updatedAt` | ISO datetime | preenchidos pelo servidor |

**Regras extras (FR-024)**: nomes de passo únicos dentro da esteira. A ordem dos passos é a ordem do array; não existe campo `position` separado. Assim o JSON é a única fonte da verdade (Princípio IV).

## 2. Step (Passo): embutido em `Pipeline.steps`

| Campo | Tipo | Regras |
|---|---|---|
| `id` | uuid | estável ao reordenar (chave de UI) |
| `name` | string | obrigatório, 1–60 caracteres |
| `model` | string | obrigatório, não vazio; alias (`opus`, `sonnet`, `haiku`) ou id completo do modelo |
| `command` | string | obrigatório, não vazio (ex.: `/speckit-plan`); é o início do prompt enviado ao agente |
| `interactive` | boolean | padrão `false` (FR-009) |
| `timeoutMinutes` | inteiro | opcional; 1–1440; quando ausente, **30** (FR-018a) |

### Esteira padrão (FR-020)

| # | name | command | model | interactive | timeoutMinutes |
|---|---|---|---|---|---|
| 1 | Specify | `/speckit-specify` | `opus` | false | — (30) |
| 2 | Clarify | `/speckit-clarify` | `opus` | **true** | — (30) |
| 3 | Plan | `/speckit-plan` | `opus` | false | — (30) |
| 4 | Tasks | `/speckit-tasks` | `sonnet` | false | — (30) |
| 5 | Implement | `/speckit-implement` | `opus` | false | **120** |

---

## 3. Run (Execução): `runs/<runId>/run.json`

| Campo | Tipo | Notas |
|---|---|---|
| `schemaVersion` | `1` | |
| `id` | uuid | |
| `pipeline` | `Pipeline` | **cópia** da definição no momento do envio (reprodutibilidade, Princípio IV) |
| `repoPath` | string | caminho absoluto normalizado (`git rev-parse --show-toplevel`) |
| `description` | string | descrição da feature; não pode ser vazia (FR-003) |
| `sourceBranch` | string | branch em uso no envio (FR-003a / FR-004) |
| `preexistingBranches` | `{ name: string; sha: string }[]` | snapshot inicial (FR-011a, R3) |
| `initialBranch` | string | branch criada pelo orquestrador (`orchestrator/...`) |
| `createdBranches` | string[] | `initialBranch` mais as branches novas detectadas ao fim de cada passo, na ordem em que aparecem |
| `finalBranch` | string \| null | branch ativa ao término (FR-017) |
| `status` | `RunStatus` | ver máquina de estados |
| `startedAt` / `finishedAt` | ISO datetime / null | |
| `steps` | `StepRun[]` | um por passo da esteira copiada, na mesma ordem |

`RunStatus` = `running` · `awaiting_input` · `completed` · `failed` · `interrupted`

## 4. StepRun (Execução de Passo): embutido em `Run.steps`

| Campo | Tipo | Notas |
|---|---|---|
| `stepId` | uuid | referência a `Run.pipeline.steps[i].id` |
| `status` | `StepStatus` | |
| `sessionId` | uuid \| null | sessão do agente (gerada pelo orquestrador) usada para `--resume` |
| `replies` | `{ at: ISO; text: string }[]` | respostas do usuário (FR-009) |
| `invocations` | `Invocation[]` | uma por chamada ao agente (inicial e por resposta) |
| `errorMessage` | string \| null | mensagem compreensível (FR-008, Princípio VI) |
| `interruptReason` | `"user"` \| `"timeout"` \| `"server_shutdown"` \| null | |
| `commitSha` | string \| null | commit criado ao fim do passo (completo ou WIP) |
| `branchAtEnd` | string \| null | branch ativa quando o passo terminou |
| `startedAt` / `finishedAt` | ISO / null | |
| `durationMs` | number \| null | soma do tempo de trabalho do agente (exclui a pausa) |
| `usage` | `Usage \| null` | soma das `invocations[].usage` |

**Invocation**: `{ startedAt, finishedAt, durationMs, outcome: "success" | "error" | "interrupted", usage: Usage | null }`

**Usage** (do evento `result` da CLI): `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd: number | null, numTurns }`. Todos os campos são opcionais e ficam nulos quando não são reportados ("quando disponível", FR-016).

## 5. OutputEntry: `runs/<runId>/<stepIndex>.output.jsonl`

`{ seq: number; at: ISO; kind: "text" | "tool_use" | "tool_result" | "user_reply" | "system" | "error"; text: string }`

O arquivo é *append-only* e fica separado de `run.json` para que a gravação contínua da saída não reescreva o registro inteiro. `seq` é monotônico por passo e permite que o cliente WebSocket retome sem duplicar entradas.

## 6. RepoInfo (não persistido; resposta de inspeção)

`{ path: string; valid: boolean; currentBranch: string | null; problems: RepoProblem[] }`

`RepoProblem` = `not_a_repo` · `dirty_worktree` · `merge_or_rebase_in_progress` · `detached_head` · `path_not_found`

## 7. Settings: `settings.json`

`{ recentRepos: string[] (≤ 10, mais recente primeiro); lastPipelineId: uuid | null }`

---

## Máquina de estados

Implementação pura em `apps/server/src/execution/state-machine.ts`:
`transitionStep(status, event) → status | InvalidTransition` e `transitionRun(...)`. Transições não listadas abaixo são **inválidas** e lançam erro (há testes que cobrem cada linha e cada transição inválida).

### StepStatus

```text
            start                  agent_success (interactive)
 waiting ─────────► running ─────────────────────────────► awaiting_input
                     │  │  agent_success (não interativo)        │   │
                     │  └───────────────────► completed ◄────────┘   │ advance
                     │ agent_error / branch_violation                │
                     ├──────────────────────► failed                 │
                     │ interrupt / timeout / shutdown                │
                     └──────────────────────► interrupted ◄──────────┘ interrupt / shutdown
           awaiting_input ── reply ──► running   (mesma sessão, limite de tempo completo)
```

| De | Evento | Para | Efeitos colaterais (executor) |
|---|---|---|---|
| waiting | `start` | running | gera `sessionId`; pré-verifica o comando (R2); inicia o agente com timeout |
| running | `agent_success` + não interativo | completed | verificação de branch (FR-011a), commit "concluído" |
| running | `agent_success` + interativo | awaiting_input | nenhum commit (FR-009a) |
| running | `agent_error` | failed | verificação de branch; commit WIP "com erro" se a branch for permitida |
| running | `branch_violation` | failed | **nenhum commit**; mensagem identifica a branch pré-existente |
| running | `interrupt` / `timeout` / `shutdown` | interrupted | encerra a árvore de processos (R5); commit WIP "interrompido" |
| awaiting_input | `reply` | running | `--resume <sessionId>` com a resposta |
| awaiting_input | `advance` | completed | verificação de branch, commit "concluído" |
| awaiting_input | `interrupt` / `shutdown` | interrupted | commit WIP (edge case da spec) |

A verificação de branch acontece **sempre** que um passo sai de `running` (inclusive em erro ou interrupção). Ela compara a branch ativa com `preexistingBranches` e verifica se algum SHA pré-existente mudou. Se a verificação falhar, o resultado vira `failed` com `branch_violation` e nada é commitado.

### RunStatus

| De | Condição | Para |
|---|---|---|
| (criação) | validações FR-002 ok e branch criada | running |
| running | passo atual → awaiting_input | awaiting_input |
| awaiting_input | `reply` | running |
| running / awaiting_input | passo → completed e há próximo passo | running (próximo passo `start`) |
| running / awaiting_input | último passo → completed | **completed** |
| running | passo → failed | **failed** (passos restantes ficam `waiting`) |
| running / awaiting_input | passo → interrupted | **interrupted** (passos restantes ficam `waiting`) |

Ao entrar num estado terminal, o executor grava `finishedAt` e `finalBranch` (branch ativa) e libera a trava de execução única (FR-012).
