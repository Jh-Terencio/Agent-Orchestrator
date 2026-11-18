# Implementation Plan: Orquestrador Visual de Esteira de Agentes

**Branch**: `001-agent-pipeline-orchestrator` | **Date**: 2026-11-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-agent-pipeline-orchestrator/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Aplicação local (servidor Node em `127.0.0.1` + SPA React) que executa, sobre um repositório Git local, uma esteira declarativa de passos de agente de IA (padrão: Specify → Clarify → Plan → Tasks → Implement do Spec Kit). Cada passo roda a **CLI do Claude Code em modo não interativo** (`claude -p --output-format stream-json`) com o login da assinatura, atrás da interface `AgentRunner`. A saída e o status chegam à UI via WebSocket. Passos não interativos recebem, via `--append-system-prompt`, a instrução de não fazer perguntas e de registrar dúvidas nos artefatos. Na esteira padrão, Clarify e Implement são interativos. Um `GitService` centraliza as validações, a criação de branch, o snapshot e a verificação de refs (`refs/heads`, `refs/remotes`, `refs/tags`) e os commits (completos e WIP). O ciclo de vida é uma máquina de estados pura e testável. A persistência usa arquivos JSON numa pasta de dados do orquestrador, fora do repositório alvo. Detalhes e justificativas: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`, `noUncheckedIndexedAccess`) em todos os pacotes; Node.js 24 LTS

**Primary Dependencies**: `zod` (schema compartilhado); `express` 5 + `ws` (servidor); `react` + `react-dom` + `vite` + `@vitejs/plugin-react` (web). Dev: `typescript`, `vitest`, `tsx`, `jsdom`, `@testing-library/react`. Agente: binário `claude` (Claude Code CLI ≥ 2.1) e `git` do sistema, invocados via `child_process`

**Storage**: arquivos JSON na pasta de dados do orquestrador (`%APPDATA%\agent-orchestrator` / `~/.local/share/agent-orchestrator`, sobrescrevível por `ORCHESTRATOR_DATA_DIR`). Saída dos passos em `.jsonl` *append-only*. Sem banco de dados

**Testing**: Vitest (server/shared: ambiente `node`; web: `jsdom` + Testing Library). `FakeAgentRunner` para o executor e repositórios Git temporários para o `GitService`

**Target Platform**: máquina do usuário. Windows 11 é o ambiente principal, e macOS/Linux são suportados (encerramento de processos específico por plataforma). Navegador moderno em `http://127.0.0.1:4317`

**Project Type**: aplicação web local (monorepo com npm workspaces: `apps/web`, `apps/server`, `packages/shared`)

**Performance Goals**: saída e status na UI em ≤ 2 s (SC-003/SC-004; lotes de WebSocket a cada ≤ 250 ms); interrupção ou timeout encerra o agente e seus subprocessos em ≤ 5 s (SC-005)

**Constraints**: escuta só em `127.0.0.1` com validação de `Origin`/`Host`; nenhuma escrita do orquestrador no repositório alvo além de branch e commits; agente sem push/merge/rebase/reset/commit; uma execução por vez; limite de tempo por invocação do agente (padrão 30 min)

**Scale/Scope**: um usuário, uma execução ativa, esteiras de ~5–10 passos, saídas de passo de até dezenas de MB, histórico ilimitado (sem índice; a listagem lê os `run.json`)

Nenhum item ficou como NEEDS CLARIFICATION. As decisões em aberto (SDK × CLI, carregamento do Spec Kit, permissões, encerramento de processos, persistência) foram resolvidas em [research.md](./research.md) R1–R12.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| **I. Uso Pessoal e Local** | `listen(4317, '127.0.0.1')`; validação de `Origin`/`Host`; sem autenticação, contas ou deploy; dados em pasta local | ✅ |
| **II. Segurança do Código Alvo** | branch nova `orchestrator/...` antes do 1º passo; snapshot (ref + SHA) de `refs/heads`, `refs/remotes` e `refs/tags`; verificação a cada fim de passo (branch ativa, branches pré-existentes, qualquer mudança em remotas/tags) → erro sem commit; agente proibido de `git commit/push/merge/rebase/reset/...` (R3); orquestrador nunca faz push ou merge; validações de FR-002 antes de iniciar | ✅ |
| **III. Simplicidade Primeiro** | 3 pacotes (exigidos pelo schema compartilhado); sem banco; `git`/`claude` via `execFile`/`spawn` em vez de bibliotecas; dependências justificadas em R7, R9 e R12; `killProcessTree` próprio em vez de `tree-kill` | ✅ |
| **IV. Pipeline como Dado** | esteira em JSON validado por Zod ao salvar, ler e executar; a UI só edita o JSON; a ordem é a ordem do array; o `Run` guarda uma cópia da definição (reprodutível) | ✅ |
| **V. Passos Pequenos e Verificáveis** | ordem de construção em 7 incrementos, cada um com testes próprios e sistema funcional (ver abaixo) | ✅ |
| **VI. Transparência em Tempo Real** | 6 estados visíveis por passo; saída em streaming via WebSocket; entrada, saída, respostas, erros, duração e consumo persistidos e consultáveis no histórico; erros com mensagem acionável | ✅ |
| **VII. Qualidade e Testes** | `strict` em todos os pacotes; `npm run typecheck` e `npm test` como gate; testes unitários (schema, máquina de estados, executor com fake, parser stream-json, permissões) e de integração (git em repositórios temporários, kill-tree, servidor) | ✅ |
| **VIII. Custo Consciente** | interromper a qualquer momento (encerra a árvore de processos); limite de tempo por passo; esteira padrão usa Opus só no Plan e Sonnet nos demais passos; consumo de cada invocação (tokens de `usage` e custo de `model_usage_since_last_result` ou diferença do `total_cost_usd`, que é acumulado na sessão, R1) exibido por passo; execuções isoladas da configuração pessoal (`--setting-sources project,local --strict-mcp-config`, R3a), sem plugins, hooks nem MCP extras; nenhuma reexecução automática (FR-019) | ✅ |

**Resultado do gate (pré-pesquisa)**: aprovado, sem violações.
**Re-check pós-design (Phase 1)**: aprovado. Os contratos e o modelo de dados não introduziram camadas nem dependências além das listadas. A única abstração (`AgentRunner`) atende a uma necessidade presente: testar o executor sem consumir a assinatura e isolar uma integração externa que pode mudar.

## Project Structure

### Documentation (this feature)

```text
specs/001-agent-pipeline-orchestrator/
├── plan.md              # Este arquivo
├── research.md          # Phase 0: decisões técnicas (R1–R12)
├── data-model.md        # Phase 1: entidades, validações e máquina de estados
├── quickstart.md        # Phase 1: guia de validação
├── contracts/
│   ├── rest-api.md            # Rotas REST
│   ├── websocket-events.md    # Eventos em tempo real
│   ├── agent-runner.md        # Interface AgentRunner + mapeamento da CLI
│   └── pipeline-definition.md # Formato JSON da esteira + esteira padrão
└── tasks.md             # Phase 2 (/speckit-tasks; não criado aqui)
```

### Source Code (repository root)

```text
package.json                 # npm workspaces + scripts: dev, build, start, test, typecheck
tsconfig.base.json           # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
packages/
└── shared/
    ├── src/
    │   ├── schemas/         # pipeline.ts, run.ts, events.ts (WS), api.ts (DTOs REST)
    │   ├── default-pipeline.ts
    │   └── index.ts
    └── tests/               # pipeline.schema.test.ts, run.schema.test.ts
apps/
├── server/
│   ├── src/
│   │   ├── git/             # git-service.ts, exec-git.ts, branch-name.ts
│   │   ├── agent/           # agent-runner.ts (interface), claude-cli-runner.ts,
│   │   │                    # stream-json-parser.ts, permissions.ts, system-prompts.ts,
│   │   │                    # kill-tree.ts, command-lookup.ts, resolve-claude.ts, relay-path.ts
│   │   ├── execution/       # state-machine.ts, pipeline-executor.ts, run-lock.ts,
│   │   │                    # pausable-timer.ts, permission-broker.ts (US6), recovery.ts
│   │   ├── storage/         # data-dir.ts, pipeline-store.ts, run-store.ts,
│   │   │                    # settings-store.ts, atomic-write.ts
│   │   ├── http/            # app.ts (express), routes/*.ts, origin-guard.ts, errors.ts
│   │   ├── ws/              # event-hub.ts (broadcast + batching de saída)
│   │   └── main.ts          # composição, listen 127.0.0.1, shutdown gracioso, recuperação
│   ├── permission-relay/    # relay.mjs: servidor MCP stdio de permissões, rodado com node puro (US6, research R13)
│   └── tests/
│       ├── unit/            # state-machine, executor (FakeAgentRunner), stream-json-parser,
│       │                    # permissions, branch-name, stores
│       ├── integration/     # git-service (repos temporários), kill-tree, server (REST+WS)
│       └── fakes/           # fake-agent-runner.ts, temp-repo.ts
└── web/
    ├── src/
    │   ├── api/             # client REST tipado, ws.ts (reconexão + afterSeq)
    │   ├── state/           # store do run ativo (reducer de ServerEvent)
    │   ├── components/      # RepoPicker, FeatureInput, PipelineBoxes, StepBox,
    │   │                    # StepOutputPanel, InteractiveReply, RunSummary
    │   ├── pages/           # RunPage, HistoryPage, PipelineEditorPage
    │   └── main.tsx
    ├── tests/
    └── vite.config.ts       # proxy /api e /ws → 127.0.0.1:4317
```

**Structure Decision**: monorepo com npm workspaces, como definido pelo usuário. `packages/shared` contém só schemas, tipos e a esteira padrão, sem lógica de I/O. `apps/server` é organizado por responsabilidade (git, agent, execution, storage, http, ws), e cada pasta é testável isoladamente. `apps/web` consome só `shared` e a API.

## Componentes-chave e responsabilidades

- **`GitService`** (`git/`): `inspect(path)` (FR-002/FR-003a), `snapshotRefs()` (`refs/heads`, `refs/remotes`, `refs/tags`), `createRunBranch(desc)` (FR-004), `currentBranch()`, `verifyAfterStep(snapshot)` (FR-011a: branch ativa, branches pré-existentes inalteradas, nenhuma mudança em remotas/tags; retorna as violações), `commitAll(message)` (pula se não houver alterações). Única porta de entrada para o `git`.
- **`AgentRunner` / `ClaudeCliRunner`** (`agent/`): ver [contracts/agent-runner.md](./contracts/agent-runner.md). Adiciona `--append-system-prompt` com `NON_INTERACTIVE_SYSTEM_PROMPT` (`agent/system-prompts.ts`) quando o passo não é interativo (FR-006a, research R2a).
- **Limite de tempo** (`execution/`): por invocação, o executor cria um `AbortController` e agenda `setTimeout(() => controller.abort("timeout"), ms)`, com `clearTimeout` ao fim. Interromper e shutdown abortam o mesmo controller com `"user"`/`"server_shutdown"`, e `signal.reason` define o `interruptReason`. `AbortSignal.timeout` não é usado porque os *fake timers* do Vitest não o controlam (research R4).
- **`PipelineExecutor`** (`execution/`): orquestra uma execução usando a máquina de estados, o `GitService`, o `AgentRunner`, o `RunStore` e o `EventHub`. Expõe `start`, `reply`, `advance`, `interrupt` e `shutdown`. Uma `RunLock` garante uma execução por vez (FR-012).
- **Permissões e Modo Yolo** (US6, research R13): fora do Modo Yolo, cada invocação recebe um canal de permissão (token aleatório) do `PermissionBroker`; a CLI consulta o relay MCP stdio (`permission-relay/relay.mjs`), que repassa o pedido a `POST /internal/permission-requests`. O executor registra o `PermissionRequest`, pausa o passo em `awaiting_permission` com o timer pausado e responde à CLI quando o usuário decide. Falhas no canal negam o pedido. Detalhamento: [`docs/superpowers/plans/2026-11-17-modo-yolo-permissoes.md`](../../docs/superpowers/plans/2026-11-17-modo-yolo-permissoes.md).
- **Shutdown** (`main.ts`): em `SIGINT`/`SIGTERM`, chama `executor.shutdown()` (interrompe com `server_shutdown`, commit WIP e persistência) e só então fecha o servidor. Na inicialização, runs não terminais são marcados como `interrupted` (R8).

## Ordem de construção (incrementos verificáveis, Princípio V)

| # | Incremento | Critério de verificação |
|---|---|---|
| 1 | Workspaces, tsconfig strict, Vitest; schemas Zod e esteira padrão em `shared` | `npm run typecheck`; testes do schema (válidos, inválidos, mensagens) |
| 2 | `GitService` | testes de integração com repositórios temporários: repo inválido, árvore suja, merge em andamento, HEAD destacado, criação de branch, commit/WIP/sem alterações, detecção de branch pré-existente ativa/alterada/removida, de tag criada/removida e de ref remota alterada (remote local apontando para outro repositório temporário) |
| 3 | `ClaudeCliRunner` executando um único passo; `kill-tree`; `permissions`; `system-prompts`; parser stream-json | testes do parser com fixtures reais gravadas (inclui `resume.jsonl` para o custo por invocação, eventos desconhecidos ignorados e `é` dividido entre chunks); teste de argumentos (inclui `--append-system-prompt` se e somente se o passo não for interativo, e sempre `--setting-sources project,local --strict-mcp-config`); teste de árvore de processos; *smoke test* manual opcional (`RUN_CLAUDE_SMOKE=1`) |
| 4 | Máquina de estados + `PipelineExecutor` (sequência, interativo, falha, interrupção, timeout via `setTimeout` + `AbortController`, shutdown, lock) + stores | testes unitários com `FakeAgentRunner` e `vi.useFakeTimers()`; o timeout dispara exatamente no limite e não conta a pausa |
| 5 | Servidor REST + WebSocket + origin guard + recuperação na inicialização | testes de integração com `fetch`/`ws` contra o servidor em porta efêmera e executor com fake |
| 6 | UI: seleção de repo, entrada, caixas, saída em tempo real, responder/avançar/interromper | testes de componentes; validação manual da quickstart, itens 1–5 |
| 7 | Histórico (lista + visualização somente leitura) e editor de esteiras | testes de componentes; quickstart, itens 6–8 |
| 8 | Pedidos de permissão em tempo real e Modo Yolo (US6) | testes do relay (protocolo stdio contra servidor HTTP de stub), do broker, do timer pausável e do executor com `FakeAgentRunner` + broker; quickstart, item 10 |

## Complexity Tracking

Nenhuma violação da constituição a justificar.
