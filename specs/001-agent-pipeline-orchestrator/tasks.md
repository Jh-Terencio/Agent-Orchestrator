---

description: "Lista de tarefas para implementar o Orquestrador Visual de Esteira de Agentes"
---

# Tasks: Orquestrador Visual de Esteira de Agentes

**Input**: documentos de design em `/specs/001-agent-pipeline-orchestrator/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: OBRIGATÓRIOS. A constituição (Princípio VII, INEGOCIÁVEL) exige testes para toda funcionalidade nova, e o plano define o critério de verificação de cada incremento. Em cada fase, escreva os testes primeiro e confirme que falham antes de implementar.

**Organization**: as tarefas estão agrupadas por história de usuário para permitir implementação e teste independentes de cada uma.

**Quality gate de toda tarefa** (constituição, "Fluxo de Desenvolvimento"): uma tarefa só está concluída quando `npm run typecheck` e `npm test` passam na raiz.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência de tarefa incompleta)
- **[Story]**: história de usuário da tarefa (US1…US5)
- Todos os caminhos são relativos à raiz do repositório

## Path Conventions

Monorepo com npm workspaces (plan.md, "Project Structure"):

- `packages/shared/src/`, `packages/shared/tests/`: schemas Zod, tipos e esteira padrão (sem I/O)
- `apps/server/src/{git,agent,execution,storage,http,ws}/`, `apps/server/tests/{unit,integration,fakes}/`
- `apps/web/src/{api,state,components,pages}/`, `apps/web/tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: inicializar o monorepo, o TypeScript strict e o Vitest (incremento 1 do plano, parte de infraestrutura)

- [X] T001 Criar `package.json` na raiz com `"private": true`, `"type": "module"`, `"engines": { "node": ">=24" }`, `"workspaces": ["packages/*", "apps/*"]` e scripts `dev` (server e web em paralelo), `build` (`npm run build -w apps/web && npm run build -w apps/server`), `start` (`node apps/server/dist/main.js`), `test` (`vitest run` em todos os workspaces) e `typecheck` (`tsc -b`)
- [X] T002 Criar `tsconfig.base.json` na raiz com `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `module`/`moduleResolution` `NodeNext` (servidor e shared), `target: ES2023`, `composite: true`, `declaration: true`, `skipLibCheck: true`; e `tsconfig.json` na raiz só com `references` para `packages/shared`, `apps/server` e `apps/web`
- [X] T003 [P] Criar o pacote `packages/shared`: `packages/shared/package.json` (nome `@orchestrator/shared`, `"exports": { ".": "./src/index.ts" }` conforme research R12, dependência `zod`, devDependency `vitest`, script `test: vitest run`), `packages/shared/tsconfig.json` (estende a base, `rootDir: src`, inclui `tests`), `packages/shared/vitest.config.ts` (`environment: "node"`) e `packages/shared/src/index.ts` vazio
- [X] T004 [P] Criar o pacote `apps/server`: `apps/server/package.json` (dependências `express@5`, `ws`, `zod`, `@orchestrator/shared`; devDependencies `typescript`, `vitest`, `tsx`, `@types/express`, `@types/ws`, `@types/node`; scripts `dev: tsx watch src/main.ts`, `build: tsc -b`, `test: vitest run`), `apps/server/tsconfig.json` (estende a base, `outDir: dist`, `references` para `packages/shared`) e `apps/server/vitest.config.ts` (`environment: "node"`, `testTimeout: 20000` para testes de git e kill-tree)
- [X] T005 [P] Criar o pacote `apps/web` com Vite + React: `apps/web/package.json` (dependências `react`, `react-dom`, `@orchestrator/shared`; devDependencies `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@types/react`, `@types/react-dom`; scripts `dev: vite`, `build: vite build`, `test: vitest run`), `apps/web/tsconfig.json` (estende a base, `jsx: react-jsx`, `moduleResolution: Bundler`, `lib` com `DOM`), `apps/web/index.html`, `apps/web/vite.config.ts` (plugin React; `server.proxy` de `/api` → `http://127.0.0.1:4317` e `/ws` → `ws://127.0.0.1:4317` com `ws: true`; bloco `test` com `environment: "jsdom"` e `setupFiles: ["./tests/setup.ts"]`) e `apps/web/tests/setup.ts` importando `@testing-library/jest-dom/vitest`
- [X] T006 [P] Criar `.gitignore` na raiz com `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/` e `.env`
- [X] T007 Rodar `npm install` na raiz e confirmar que `npm run typecheck` e `npm test` (com `passWithNoTests`) passam com os pacotes vazios

**Checkpoint**: monorepo instalado, `typecheck` e `test` verdes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema compartilhado, persistência, `GitService`, máquina de estados, interface do agente, esqueleto do servidor (REST + WS) e da UI. Tudo aqui é usado por mais de uma história.

**⚠️ CRITICAL**: nenhuma história de usuário começa antes do fim desta fase.

### Schemas compartilhados (incremento 1 do plano)

- [X] T008 [P] Escrever testes do schema da esteira em `packages/shared/tests/pipeline.schema.test.ts`: aceita a esteira padrão; rejeita com o `path` e a mensagem exatos da tabela de contracts/pipeline-definition.md — `name: ""` → `["name"]` "Informe um nome para a esteira"; `steps: []` → `["steps"]` "A esteira precisa de pelo menos um passo"; passo sem `command` → `["steps", i, "command"]` "Informe a skill ou comando do passo"; `timeoutMinutes: 0` → `["steps", i, "timeoutMinutes"]` "O limite de tempo deve estar entre 1 e 1440 minutos"; dois passos com o mesmo nome → `["steps", i, "name"]` "Já existe um passo com este nome"; nome com 81 caracteres após `trim` é rejeitado; nome de passo com 61 caracteres é rejeitado; `timeoutMinutes: 1441` e `timeoutMinutes: 1.5` são rejeitados; `interactive` ausente vira `false`
- [X] T009 [P] Escrever testes dos schemas de execução em `packages/shared/tests/run.schema.test.ts`: `Run` válido completo; `RunStatus` só aceita `running`/`awaiting_input`/`completed`/`failed`/`interrupted`; `StepStatus` só aceita `waiting`/`running`/`awaiting_input`/`completed`/`failed`/`interrupted`; `interruptReason` só aceita `"user"`/`"timeout"`/`"server_shutdown"`/`null`; `OutputEntry.kind` só aceita `text`/`tool_use`/`tool_result`/`user_reply`/`system`/`error`; `Usage` aceita todos os campos nulos; `ServerEvent` discrimina `hello`/`run.updated`/`step.output`/`run.finished`; `RunSummary.descriptionPreview` com mais de 120 caracteres é rejeitado; `RunSummary` exige `totalDurationMs: number | null` e `totalUsage: Usage | null`; `Invocation` exige `prompt` e aceita `sessionCostUsd: number | null`; `StartRunRequest` exige `expectedBranch`. E, em `packages/shared/tests/run-totals.test.ts` (FR-017a, data-model.md §4a): `computeRunTotals` soma `durationMs` ignorando nulos e retorna `null` se nenhum passo tiver duração; soma `usage` campo a campo, com cada campo `null` se nenhum passo o reportou; retorna `usage: null` se nenhum passo tiver `usage`; run sem passos iniciados → `{ durationMs: null, usage: null }`
- [X] T010 [P] Implementar `packages/shared/src/schemas/pipeline.ts` conforme data-model.md §1–2: `StepSchema` (`id` uuid; `name` string "obrigatório, 1–60 caracteres"; `model` string "obrigatório, não vazio"; `command` string "obrigatório, não vazio"; `interactive` boolean "padrão `false`"; `timeoutMinutes` inteiro "opcional; 1–1440"), `PipelineSchema` (`schemaVersion: z.literal(1)`; `id` uuid; `name` "obrigatório, 1–80 caracteres após `trim`"; `isDefault` boolean; `steps` "mínimo 1"; `createdAt`/`updatedAt` ISO datetime; `superRefine` para "nomes de passo únicos dentro da esteira"), `StepInputSchema` (igual a `Step` com `id` opcional), `PipelineInputSchema` (`{ name, steps: StepInput[] }`), a constante `DEFAULT_TIMEOUT_MINUTES = 30` e os tipos via `z.infer`, todos com as mensagens em português de T008
- [X] T011 [P] Implementar `packages/shared/src/schemas/run.ts` conforme data-model.md §3–7: `RunStatusSchema`, `StepStatusSchema`, `UsageSchema` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `numTurns`, todos `number | null`), `InvocationSchema` (`prompt` — texto exato enviado ao agente, entrada do passo (FR-016) —, `startedAt`, `finishedAt`, `durationMs`, `outcome: "success" | "error" | "interrupted"`, `usage` (só desta invocação), `sessionCostUsd: number | null` — `total_cost_usd` bruto acumulado na sessão, base para a próxima diferença, research R1), `StepRunSchema` (`stepId`, `status`, `sessionId: uuid | null`, `replies: { at, text }[]`, `invocations`, `errorMessage`, `interruptReason`, `commitSha`, `branchAtEnd`, `startedAt`, `finishedAt`, `durationMs`, `usage`), `RunSchema` (`schemaVersion: 1`, `id`, `pipeline` (cópia), `repoPath`, `description` não vazia, `sourceBranch`, `refSnapshot: { ref, sha }[]`, `initialBranch`, `createdBranches: string[]`, `finalBranch: string | null`, `status`, `startedAt`, `finishedAt`, `steps`), `OutputEntrySchema` (`seq`, `at`, `kind`, `text`), `RepoProblemSchema` (`not_a_repo`, `dirty_worktree`, `merge_or_rebase_in_progress`, `detached_head`, `path_not_found`), `RepoInfoSchema` (`path`, `valid`, `currentBranch: string | null`, `problems`) e `SettingsSchema` (`recentRepos` "≤ 10, mais recente primeiro"; `lastPipelineId: uuid | null`); e `packages/shared/src/run-totals.ts` com `RunTotals` e a função pura `computeRunTotals(run)` conforme data-model.md §4a (sem campo novo em `run.json`)
- [X] T012 [P] Implementar `packages/shared/src/schemas/events.ts` com `ServerEventSchema` (união discriminada por `type`: `hello { activeRun: Run | null }`, `run.updated { run }`, `step.output { runId, stepIndex, entries: OutputEntry[] }`, `run.finished { run }`) conforme contracts/websocket-events.md
- [X] T013 [P] Implementar `packages/shared/src/schemas/api.ts` com os DTOs REST de contracts/rest-api.md: `ApiErrorSchema` (`{ error: { code, message, issues?, details? } }` com `code` em `VALIDATION_FAILED`/`NOT_FOUND`/`RUN_ALREADY_ACTIVE`/`INVALID_STATE`/`BRANCH_CHANGED`/`REPO_REJECTED`/`PIPELINE_INVALID`/`FORBIDDEN_ORIGIN`), `StartRunRequestSchema` (`{ repoPath, pipelineId, description, expectedBranch }` com descrição não vazia após `trim` e `expectedBranch` não vazio), `ReplyRequestSchema` (`{ text }` não vazio) e `RunSummarySchema` (`id`, `startedAt`, `repoPath`, `pipelineName`, `descriptionPreview` "≤ 120 caracteres", `status`, `finalBranch`, `totalDurationMs: number | null`, `totalUsage: Usage | null`)
- [X] T014 Implementar `packages/shared/src/default-pipeline.ts` exportando `createDefaultPipeline(now: string): Pipeline` com `id` fixo `00000000-0000-4000-8000-000000000001`, `name` "Spec Kit (padrão)", `isDefault: true` e os passos de data-model.md "Esteira padrão": Specify (`/speckit-specify`, `sonnet`, não interativo), Clarify (`/speckit-clarify`, `sonnet`, **interativo**), Plan (`/speckit-plan`, **`opus`**, não interativo), Tasks (`/speckit-tasks`, `sonnet`, não interativo), Implement (`/speckit-implement`, `sonnet`, **interativo**, `timeoutMinutes: 120`), com ids de passo fixos; adicionar ao teste T008 que `createDefaultPipeline` passa no `PipelineSchema`
- [X] T015 Exportar todos os schemas, tipos, `computeRunTotals` e `createDefaultPipeline` em `packages/shared/src/index.ts` e confirmar `npm test -w packages/shared` verde

### Persistência (pasta de dados, research R8)

- [X] T016 [P] Escrever testes dos stores em `apps/server/tests/unit/stores.test.ts` usando `ORCHESTRATOR_DATA_DIR` apontando para uma pasta `fs.mkdtemp`: `atomicWriteJson` não deixa `*.tmp` e substitui o conteúdo; `PipelineStore.init()` grava a esteira padrão quando `pipelines/` está vazia e não a regrava se já houver arquivos; `PipelineStore.list()` retorna a padrão primeiro e depois por nome; com um arquivo de esteira inválido no disco, `list()` o **ignora** e registra aviso (com caminho e `issues`), e `get(id)` desse arquivo lança `ApiError 422 PIPELINE_INVALID` com as `issues`; `RunStore.save/get` faz ida e volta do `Run`; `RunStore.appendOutput` grava uma linha por entrada em `runs/<runId>/<stepIndex>.output.jsonl` e `readOutput(runId, stepIndex, afterSeq)` devolve só `seq > afterSeq`; `SettingsStore.addRecentRepo` mantém no máximo 10, mais recente primeiro, sem duplicatas
- [X] T017 [P] Implementar `apps/server/src/storage/data-dir.ts`: `resolveDataDir()` retorna `ORCHESTRATOR_DATA_DIR` se definido, senão `%APPDATA%\agent-orchestrator` no Windows e `~/.local/share/agent-orchestrator` nos demais; `ensureDataDirs()` cria `pipelines/` e `runs/`
- [X] T018 [P] Implementar `apps/server/src/storage/atomic-write.ts` com `atomicWriteJson(path, value)` (grava `<path>.tmp` e faz `rename`)
- [X] T019 Implementar `apps/server/src/storage/pipeline-store.ts` (`init`, `list`, `get`, `create`, `update`, `delete`, `nameExists(name, exceptId?)`), lendo e validando cada `pipelines/<id>.json` com `PipelineSchema` e gravando com `atomicWriteJson`; `list()` ignora arquivos inválidos com `console.warn` e `get(id)` lança `422 PIPELINE_INVALID` (data-model.md §1, "Arquivo inválido no disco"); `init` grava `createDefaultPipeline` se a pasta estiver vazia (FR-020)
- [X] T020 Implementar `apps/server/src/storage/run-store.ts` (`save(run)` atômico em `runs/<runId>/run.json`, `get(id)`, `listAll()` lendo todos os `run.json`, `appendOutput(runId, stepIndex, entries)` em modo append no `.output.jsonl`, `readOutput(runId, stepIndex, afterSeq?)`, `nextSeq(runId, stepIndex)` monotônico por passo)
- [X] T021 [P] Implementar `apps/server/src/storage/settings-store.ts` (`get()`, `addRecentRepo(path)` com limite de 10, `setLastPipelineId(id)`) em `settings.json`, validado por `SettingsSchema`

### GitService (incremento 2 do plano, research R6)

- [X] T022 [P] Criar o helper de testes `apps/server/tests/fakes/temp-repo.ts`: `createTempRepo()` (`fs.mkdtemp` + `git init -b main` + `user.name`/`user.email` locais + commit inicial), `createRemoteFor(repo)` (segundo repositório temporário como `origin`, com `git fetch` para criar `refs/remotes/origin/main`), `writeFile`, `git(...)` e `cleanup()`
- [X] T023 [P] Escrever testes de integração em `apps/server/tests/integration/git-service.test.ts` cobrindo o critério do incremento 2: pasta inexistente → `path_not_found`; pasta sem git → `not_a_repo`; arquivo modificado e arquivo não rastreado → `dirty_worktree`; `MERGE_HEAD` presente → `merge_or_rebase_in_progress`; HEAD destacado → `detached_head`; repo limpo → `valid: true` com `currentBranch: "main"` e `path` igual a `git rev-parse --show-toplevel`; `snapshotRefs` lista `refs/heads/*`, `refs/remotes/*` e `refs/tags/*` com SHA; `createRunBranch` cria e troca para `orchestrator/<AAAAMMDD-HHmmss>-<slug>` e falha se o nome já existir; `commitAll` cria commit com trailer `Orchestrator-Run: <runId>` e retorna `null` sem alterações; `verifyAfterStep` retorna violação para: branch ativa pré-existente, branch pré-existente com SHA alterado, branch pré-existente removida, tag criada, tag removida, ref remota alterada; e não retorna violação para uma branch nova criada pelo passo (que aparece em `newBranches`)
- [X] T024 [P] Escrever testes unitários em `apps/server/tests/unit/branch-name.test.ts`: `buildRunBranchName(description, date)` gera `orchestrator/<AAAAMMDD-HHmmss>-<slug≤40>`, remove acentos, troca não alfanuméricos por `-`, colapsa hífens, não termina em `-`, usa `run` como slug quando a descrição não tem caracteres válidos
- [X] T025 [P] Implementar `apps/server/src/git/exec-git.ts`: `execGit(cwd, args)` via `child_process.execFile("git", args, { cwd, maxBuffer: 64 MB })` sem shell, retornando `{ stdout, stderr, code }`, e erro com mensagem acionável quando o `git` não está no PATH
- [X] T026 [P] Implementar `apps/server/src/git/branch-name.ts` com `buildRunBranchName` conforme T024
- [X] T027 Implementar `apps/server/src/git/git-service.ts` com os comandos da tabela de research R6: `inspect(path): RepoInfo` (FR-002/FR-003a), `currentBranch()`, `snapshotRefs()` (`git for-each-ref --format="%(refname) %(objectname)" refs/heads refs/remotes refs/tags`), `createRunBranch(description)` (`git switch -c`), `hasChanges()`, `commitAll(message, runId): string | null` (`git add -A` + `git commit -m` com trailer; retorna o SHA ou `null` sem alterações), `verifyAfterStep(snapshot): { violations: string[]; activeBranch: string; newBranches: string[] }` com as três regras de FR-011a; mensagens das violações citam o nome completo da ref afetada

### Máquina de estados (data-model.md "Máquina de estados")

- [X] T028 [P] Escrever testes em `apps/server/tests/unit/state-machine.test.ts` cobrindo cada linha das tabelas `StepStatus` e `RunStatus` de data-model.md (waiting→running em `start`; running→completed em `agent_success` não interativo; running→awaiting_input em `agent_success` interativo; running→failed em `agent_error` e `ref_violation`; running→interrupted em `interrupt`/`timeout`/`shutdown`; awaiting_input→running em `reply`; awaiting_input→completed em `advance`; awaiting_input→failed em `ref_violation`; awaiting_input→interrupted em `interrupt`/`shutdown`; e, no `RunStatus`, awaiting_input→failed quando o passo vai a `failed`) e verificando que toda combinação não listada lança `InvalidTransition` (incluindo `timeout` em `awaiting_input` e qualquer evento em estado terminal)
- [X] T029 [P] Implementar `apps/server/src/execution/state-machine.ts` puro (sem I/O): tipos `StepEvent`, `transitionStep(status, event, { interactive }) → StepStatus` e `transitionRun(...)`, lançando `InvalidTransition` com `from`/`event` para transições não listadas

### Interface do agente

- [X] T030 [P] Implementar `apps/server/src/agent/agent-runner.ts` com `AgentInvocation`, `AgentOutcome` e `AgentRunner` exatamente como em contracts/agent-runner.md (incluindo o comentário "nunca rejeita; erros viram `{ kind: "error" }`")
- [X] T031 [P] Implementar `apps/server/tests/fakes/fake-agent-runner.ts`: roteiro programável por chamada (entradas de `onOutput`; `sideEffect?: (cwd) => Promise<void>` opcional que simula o trabalho do agente no repositório — escrever arquivos, `git switch -c`, trocar para branch pré-existente, criar tag — e roda antes de resolver, inclusive quando interrompido; atraso via `setTimeout` compatível com `vi.useFakeTimers()`; resultado `success`/`error`, com `usage` e `sessionCostUsd` configuráveis), conforme contracts/agent-runner.md, respeita `signal` resolvendo `interrupted` ao abortar, e registra as invocações recebidas (`prompt`, `model`, `sessionId`, `resume`, `interactive`, `priorSessionCostUsd`) para asserções

### Servidor HTTP + WebSocket (esqueleto, research R7)

- [X] T032 [P] Escrever testes em `apps/server/tests/integration/server.test.ts` (servidor em porta efêmera, data dir temporário, `FakeAgentRunner`): `server.address().address === "127.0.0.1"`; requisição com `Origin: http://evil.example` → `403 FORBIDDEN_ORIGIN`; `Host` não local → `403`; upgrade WS com `Origin` estranho é recusado; conexão WS local recebe `hello` com `activeRun: null`; `GET /api/settings` → `200 Settings`; `GET /api/repos/inspect?path=<repo temporário>` → `200 RepoInfo` válido e, para pasta inexistente, `200` com `problems: ["path_not_found"]`
- [X] T033 [P] Implementar `apps/server/src/http/errors.ts`: classe `ApiError(status, code, message, issues?, details?)`, `fromZodError` (→ `400 VALIDATION_FAILED` com `issues[].path/message`) e middleware Express que serializa no formato `{ error: { code, message, issues?, details? } }` de contracts/rest-api.md
- [X] T034 [P] Implementar `apps/server/src/http/origin-guard.ts`: `isAllowedOrigin(origin, port, devPorts)` aceitando só `http://127.0.0.1:<porta>` e `http://localhost:<porta>` (mais a porta do Vite em dev) ou ausência de `Origin`, e `isAllowedHost(host, port)`; middleware Express que responde `403 FORBIDDEN_ORIGIN`; e função reutilizada pelo upgrade WS
- [X] T035 Implementar `apps/server/src/ws/event-hub.ts`: `EventHub` que anexa um `WebSocketServer` (`noServer: true`) ao `http.Server` com validação de origem no `upgrade`, envia `hello { activeRun }` na conexão e expõe `broadcast(event: ServerEvent)` validado por `ServerEventSchema`
- [X] T036 Implementar `apps/server/src/http/routes/repos.ts` (`GET /repos/inspect?path=` → `GitService.inspect`, sempre 200) e `apps/server/src/http/routes/settings.ts` (`GET /settings`)
- [X] T037 Implementar `apps/server/src/http/app.ts`: `createApp(deps)` com `express.json()`, origin guard, rotas sob `/api` e middleware de erros; e `apps/server/src/main.ts` com a composição (data dir, stores com `PipelineStore.init()`, `GitService`, `EventHub`) e `listen(ORCHESTRATOR_PORT ?? 4317, "127.0.0.1")`, exportando `startServer(options)` para os testes

### Esqueleto da UI

- [X] T038 [P] Implementar `apps/web/src/api/client.ts`: funções REST tipadas com os tipos de `@orchestrator/shared` (`inspectRepo`, `getSettings`, `listPipelines`, `getPipeline`, `createPipeline`, `updatePipeline`, `duplicatePipeline`, `deletePipeline`, `startRun`, `getActiveRun`, `getRun`, `listRuns`, `getStepOutput(runId, index, afterSeq?)`, `reply`, `advance`, `interrupt`) que lançam `ApiClientError` com `code`, `message` e `issues` do corpo de erro
- [X] T039 [P] Implementar `apps/web/src/api/ws.ts`: `connectEvents(onEvent, onStatus)` em `/ws`, valida cada mensagem com `ServerEventSchema`, reconecta com backoff (até 5 s) e notifica `onStatus("connected" | "reconnecting")`
- [X] T040 [P] Escrever testes em `apps/web/tests/run-store.test.ts` para o reducer: `hello` define o run ativo; `run.updated` substitui o snapshot; `run.finished` marca terminal; `step.output` acrescenta entradas por passo e ignora `seq` já visto
- [X] T041 Implementar `apps/web/src/state/run-store.ts`: reducer de `ServerEvent` + hook `useRunStore()` (`useReducer` + contexto) com estado `{ run: Run | null; outputs: Record<stepIndex, OutputEntry[]>; lastSeq: Record<stepIndex, number>; connection }`
- [X] T042 Implementar `apps/web/src/main.tsx` e `apps/web/src/App.tsx` com navegação simples por estado (abas "Executar", "Histórico", "Esteiras"; as duas últimas mostram um placeholder "Disponível em breve" até T097 e T092 criarem as páginas) e `apps/web/src/pages/RunPage.tsx` vazio; estilos base em `apps/web/src/styles.css`

**Checkpoint**: `npm run typecheck` e `npm test` verdes; servidor sobe em `127.0.0.1:4317`, inspeciona repositórios e aceita WebSocket local. As histórias podem começar.

---

## Phase 3: User Story 1 - Executar a esteira padrão do Spec Kit de ponta a ponta (Priority: P1) 🎯 MVP

**Goal**: selecionar um repositório, descrever a feature, enviar, e ver a esteira padrão rodar Specify → Clarify → Plan → Tasks → Implement com o Claude Code CLI, com branch nova, commits por passo, verificação de refs e responder/avançar nos passos interativos.

**Independent Test**: num repositório de teste com Spec Kit, enviar uma descrição simples, responder/avançar no Clarify e no Implement, e verificar que os cinco passos ficam "concluído", que há commits só em branches criadas pela execução e que a branch de origem tem o mesmo SHA de antes (quickstart, validação manual 1).

### Tests for User Story 1 ⚠️

> Escreva estes testes primeiro e confirme que falham antes da implementação.

- [X] T043 [P] [US1] Gravar fixtures reais de saída `stream-json` em `apps/server/tests/fixtures/stream-json/` (`success.jsonl` com `system` init, deltas de texto (`text_delta`) e de ferramenta (`input_json_delta`), `tool_use`, `tool_result`, `rate_limit_event` e `result` com `usage`/`total_cost_usd`/`model_usage_since_last_result`; `resume.jsonl` com a 2ª invocação da mesma sessão (`--resume`), cujo `result` tem `total_cost_usd` **acumulado** e `model_usage_since_last_result`/`usage` só da invocação; `error-result.jsonl` com `is_error: true`; `question-ending.jsonl` terminando em pergunta; `auth-error.jsonl` com o `result` de erro de autenticação emitido quando a CLI não está logada) capturadas com os argumentos de `buildClaudeArgs` (T052), incluindo `--setting-sources project,local --strict-mcp-config`. `success.jsonl` e `resume.jsonl` são capturadas em sequência com o mesmo `--session-id`/`--resume` (como no teste de validação de 2026-11-17, em que `total_cost_usd` foi 0,1309 e depois 0,1379, com `model_usage_since_last_result` 0,1309 e depois 0,0070). A captura é um **passo manual, feito uma única vez** (consome a assinatura; os testes nunca chamam o `claude` real). **Sanitizar antes de commitar, porque o repositório é público no GitHub**: trocar `session_id`/`uuid`/ids de mensagem por UUIDs fixos fictícios, caminhos locais (`cwd`, caminhos em `tool_use`/`tool_result`, nome de usuário do Windows) por `/repo/...`, e remover e-mail, nome da conta, organização e qualquer token ou conteúdo do repositório real; documentar o procedimento em `apps/server/tests/fixtures/stream-json/README.md` e revisar o diff das fixtures antes do commit
- [X] T044 [P] [US1] Escrever testes em `apps/server/tests/unit/stream-json-parser.test.ts` com as fixtures de T043, cobrindo a tabela de contracts/agent-runner.md: delta de texto → `text`; `tool_use` → `"<Ferramenta>: <resumo>"`; `tool_result` → `tool_result`; `system` init → `"modelo X, sessão Y"`; `result` sem erro → `success` com `Usage` mapeado (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `numTurns`) e `sessionCostUsd` = `total_cost_usd` bruto; `result` com `is_error` → `error` com mensagem; `auth-error.jsonl` → `error` com a mensagem acionável de contracts/agent-runner.md ("Claude Code não está autenticado. Rode `claude` num terminal e faça `/login`…"); **custo por invocação (research R1)**: com `resume.jsonl`, `costUsd` é a soma de `model_usage_since_last_result[*].costUSD` (o valor da invocação, e não o `total_cost_usd` acumulado) e os tokens são os de `usage` da invocação; com uma cópia de `resume.jsonl` sem `model_usage_since_last_result` e `priorSessionCostUsd` = `sessionCostUsd` de `success.jsonl`, `costUsd` = `total_cost_usd − priorSessionCostUsd`; sem `model_usage_since_last_result` e com `priorSessionCostUsd: null`, `costUsd` = `null`; na 1ª invocação (`priorSessionCostUsd: 0`), `costUsd` = `total_cost_usd`; a soma de `success` + `resume` é igual ao `total_cost_usd` final da sessão; **eventos desconhecidos**: `rate_limit_event`, `system` com `subtype` `status`/`hook_started`/`hook_response`/`hook_progress`, `stream_event` com `input_json_delta`/`message_start` e uma linha com `type` inventado são ignorados sem lançar e sem gerar `onOutput`; bloco `text` dentro de `assistant` não gera `text` duplicado; **UTF-8**: uma linha com `"é"` cujo `Buffer` é cortado entre `0xC3` e `0xA9` em dois chunks gera o texto com `é` correto (sem `�` nem `Ã©`); linha não JSON é ignorada sem lançar; linha quebrada em dois chunks é remontada; `\r\n` é aceito como fim de linha
- [X] T045 [P] [US1] Escrever testes em `apps/server/tests/unit/permissions.test.ts`: `buildClaudeArgs(invocation)` gera `-p <prompt> --output-format stream-json --verbose --include-partial-messages --model <model> --permission-mode acceptEdits`, **sempre** `--setting-sources project,local` e `--strict-mcp-config` (com e sem `resume`, interativo ou não; research R3a), `--session-id <id>` quando `resume === false` e `--resume <id>` quando `true`, `--allowedTools` e `--disallowedTools` com todas as regras de research R3 (versões `Bash(...)` e `PowerShell(...)`), e `--append-system-prompt <NON_INTERACTIVE_SYSTEM_PROMPT>` **se e somente se** `interactive === false`
- [X] T046 [P] [US1] Escrever testes em `apps/server/tests/unit/command-lookup.test.ts`: `commandExists(repo, "/speckit-plan")` é `true` quando existe `<repo>/.claude/skills/speckit-plan/SKILL.md` ou `<repo>/.claude/commands/speckit-plan.md`; `false` caso contrário, **inclusive** quando o comando só existe em `~/.claude/skills/` ou `~/.claude/commands/` (com `--setting-sources project,local` as skills pessoais não carregam, research R2/R3a; o teste cria esses arquivos num `HOME` temporário para provar que não são considerados); prompts que não começam com `/` retornam `true` sem verificar. E, em `apps/server/tests/unit/resolve-claude.test.ts`, um caso para cada linha da tabela "Resolução do executável" de contracts/agent-runner.md (com `exists`/`readFile` falsos): win32 com `claude.exe` e `claude.cmd` → usa `claude.exe`; win32 só com `claude.cmd` e `cli.js` existente → `{ command: process.execPath, prefixArgs: ["<cli.js>"] }`; win32 com `claude.cmd` sem `cli.js` → erro "não consegui localizar o cli.js"; win32 sem nenhum → erro "não encontrado no PATH"; POSIX → `claude`; e nenhum caso retorna opção de shell
- [X] T047 [P] [US1] Escrever testes em `apps/server/tests/unit/executor.test.ts` (grupo "US1") com `FakeAgentRunner`, `GitService` real sobre repositório temporário (T022) e stores em pasta temporária: `start` valida o repositório (FR-002) e recusa com `REPO_REJECTED` repositório sujo, com merge em andamento ou HEAD destacado, sem criar branch; cria a branch `orchestrator/...`, grava `refSnapshot` e roda os passos em ordem; o 1º passo recebe `"<command> <descrição>"` e os demais só `"<command>"`; cada passo usa o `model` configurado e um `sessionId` novo; passo não interativo concluído → commit `orchestrator: <passo> concluído` e próximo passo inicia; passo interativo → `awaiting_input` sem commit; `reply` → nova invocação com `resume: true` e o mesmo `sessionId`, resposta registrada em `replies` e como `OutputEntry` `user_reply`, volta a `awaiting_input`; `advance` → verificação de refs, commit e próximo passo; último passo concluído → run `completed` com `finalBranch` e `createdBranches`; passo que cria e troca para branch nova → commit nela e ela entra em `createdBranches`; passo que termina em branch pré-existente → `failed` com mensagem citando a branch, nenhum commit, passos restantes `waiting`; tag criada pelo passo → `failed` sem commit; agente com `error` → passo `failed` com `errorMessage`, commit `WIP: passo <passo> com erro` se houver alterações, run `failed`; comando inexistente → `failed` sem invocar o agente; segunda chamada a `start` com run ativo → `RUN_ALREADY_ACTIVE`; `durationMs` e `usage` do passo são as somas das `invocations`; a invocação inicial recebe `priorSessionCostUsd: 0` e cada `reply` recebe o `sessionCostUsd` da invocação anterior do passo; com o fake devolvendo `costUsd` 0,13 e depois 0,007 (e `sessionCostUsd` 0,13 e depois 0,137), o `usage.costUsd` do passo é 0,137, e não 0,267; cada `Invocation` grava o `prompt` enviado e a invocação inicial gera a entrada `system` "Entrada: <prompt>" (FR-016); `expectedBranch` diferente da branch atual → `BRANCH_CHANGED` com `details.currentBranch`, sem criar branch e sem ocupar o lock; falha em `createRunBranch` (nome já existe) → `REPO_REJECTED` e o lock é liberado (um `start` seguinte funciona); `advance` com violação de refs (o `sideEffect` do fake ou o teste troca para a branch de origem durante a pausa) → passo `failed`, nenhum commit, run `failed`, passos restantes `waiting`. Usar o `sideEffect` do `FakeAgentRunner` (T031) para todas as alterações no repositório
- [X] T048 [P] [US1] Escrever testes em `apps/server/tests/integration/runs-api.test.ts` (servidor em porta efêmera, `FakeAgentRunner`): `POST /api/runs` → `201 Run` e o run evolui até `completed`; corpo sem descrição → `400 VALIDATION_FAILED`; repositório sujo → `422 REPO_REJECTED` com `details.problems`; segundo `POST` com run ativo → `409 RUN_ALREADY_ACTIVE`; `expectedBranch` diferente → `409 BRANCH_CHANGED` com `details.currentBranch`; esteira com arquivo inválido → `422 PIPELINE_INVALID`; `GET /api/runs/active` → `200 Run` ou `204`; `GET /api/runs/:id` inexistente → `404 NOT_FOUND`; `POST /reply` e `/advance` → `202` em `awaiting_input` e `409 INVALID_STATE` fora dele; `POST /reply` com `text` vazio → `400`; o cliente WS recebe `run.updated` a cada mudança e `run.finished` no fim
- [X] T049 [P] [US1] Escrever testes de componente em `apps/web/tests/run-page.us1.test.tsx` (com `client.ts` mockado): `RepoPicker` mostra a branch atual após inspecionar e os problemas quando inválido; lista de recentes preenche o caminho; botão "Enviar" desabilitado com descrição vazia ou só espaços e com repositório inválido (FR-003); enviar chama `startRun` com `expectedBranch` igual à branch exibida e mostra o erro da API quando recusado; resposta `409 BRANCH_CHANGED` atualiza a branch exibida para `details.currentBranch`, mostra um aviso e não reenvia sozinho (o usuário precisa clicar em "Enviar" de novo, FR-003a); `InteractiveReply` aparece só com passo em `awaiting_input`, envia a resposta e o "Avançar"; `RunSummary` mostra status geral, branch final, branches criadas (FR-017), duração total e consumo total calculados por `computeRunTotals`, e "consumo indisponível" quando nenhum passo reportou consumo (FR-017a)

### Implementation for User Story 1

- [X] T050 [P] [US1] Implementar `apps/server/src/agent/stream-json-parser.ts`: `createStreamJsonParser({ onOutput, priorSessionCostUsd })` que recebe chunks de stdout como `Buffer`, decodifica com um `StringDecoder("utf8")` próprio **antes** de separar as linhas (research R10), separa linhas (remontando linhas quebradas e removendo `\r` final; `end()` processa o resto), mapeia cada linha conforme a tabela de contracts/agent-runner.md, ignora sem lançar os tipos não usados e qualquer `type` desconhecido, e expõe `getResult(): { isError, message, usage, sessionCostUsd, sessionId } | null`, com `usage.costUsd` calculado pela regra de research R1 (`model_usage_since_last_result` → diferença de `total_cost_usd` → `null`); `tool_result` entra completo na entrada (o truncamento de 4 KB é só na exibição, research R10)
- [X] T051 [P] [US1] Implementar `apps/server/src/agent/system-prompts.ts` com a constante `NON_INTERACTIVE_SYSTEM_PROMPT` com o texto exato de research R2a
- [X] T052 [P] [US1] Implementar `apps/server/src/agent/permissions.ts` com as constantes `ALLOWED_TOOLS` (`Read Edit Write Glob Grep Skill TodoWrite Bash PowerShell`) e `DISALLOWED_TOOLS` (regras `git push`, `git merge`, `git rebase`, `git reset`, `git commit`, `git cherry-pick`, `git revert`, `git tag`, `git branch -D`, `git branch -d`, `git update-ref`, cada uma como `Bash(<cmd>:*)` e `PowerShell(<cmd>:*)`), a constante `ISOLATION_ARGS` (`--setting-sources project,local`, `--strict-mcp-config`; research R3a) e `buildClaudeArgs(invocation)` conforme T045
- [X] T053 [P] [US1] Implementar `apps/server/src/agent/command-lookup.ts` com `commandExists(repo, prompt)` conforme T046 e research R2 (só o repositório; sem `~/.claude`), e `apps/server/src/agent/resolve-claude.ts` com `resolveClaudeCommand` (função pura com I/O injetado) conforme a tabela "Resolução do executável" de contracts/agent-runner.md: no Windows prefere `claude.exe`; só com `claude.cmd`, resolve o `cli.js` a partir do shim e retorna `process.execPath` + `[cli.js]`; senão, erro acionável; nunca `shell: true`
- [X] T054 [US1] Implementar `apps/server/src/agent/claude-cli-runner.ts`: `ClaudeCliRunner implements AgentRunner` que chama `resolveClaudeCommand` (T053; se retornar `error`, resolve `kind: "error"` sem iniciar processo) e faz `spawn(command, [...prefixArgs, ...buildClaudeArgs(inv)], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })`, **sem** `shell: true` e **sem** `setEncoding` no stdout (os `Buffer`s vão direto ao `stream-json-parser`, que decodifica com `StringDecoder`), passa `invocation.priorSessionCostUsd` ao parser, mede `durationMs`, guarda as últimas linhas de stderr (decodificadas com outro `StringDecoder("utf8")`), devolve `sessionCostUsd` no `AgentOutcome`, e resolve (nunca rejeita) com `success`/`error` conforme o evento `result`; saída ≠ 0 sem `result` → `error` com o fim do stderr; `ENOENT` → `error` "Claude Code não encontrado no PATH. Instale e rode `claude` uma vez para fazer login."; garante que `onOutput` não é chamado depois de resolver (o tratamento de `signal` vem em US3, T081)
- [X] T055 [P] [US1] Implementar `apps/server/src/execution/run-lock.ts`: `RunLock` com `acquire(runId)` (lança `ApiError 409 RUN_ALREADY_ACTIVE` se ocupado), `release(runId)` e `activeRunId`
- [X] T056 [US1] Implementar `apps/server/src/execution/pipeline-executor.ts` (parte US1) com `PipelineExecutor({ git, agentRunner, runStore, settingsStore, eventHub, lock, clock })`: `start({ repoPath, pipeline, description, expectedBranch })` (revalida com `GitService.inspect` e lança `422 REPO_REJECTED` com `details.problems`; compara `currentBranch` com `expectedBranch` e lança `409 BRANCH_CHANGED` com `details.currentBranch` se diferir, antes de ocupar o lock; adquire o lock; cria a branch inicial — se `createRunBranch` falhar, libera o lock num `finally`/`catch` e lança `422 REPO_REJECTED` com o motivo; grava o `Run` com cópia da esteira, `sourceBranch`, `refSnapshot`, `initialBranch`, `createdBranches = [initialBranch]`, passos `waiting`; adiciona o repositório aos recentes; inicia o 1º passo de forma assíncrona e retorna o `Run`); laço de passos usando `transitionStep`/`transitionRun`: pré-verifica o comando (T053), gera `sessionId`, monta o prompt (descrição só no 1º passo, FR-006), na invocação inicial grava a entrada `system` "Entrada: <prompt>" (FR-016), invoca o runner com `interactive` do passo e `priorSessionCostUsd` (0 na invocação inicial; nas respostas, o `sessionCostUsd` da última `Invocation` do passo), grava cada saída com `RunStore.appendOutput` e `seq` monotônico, registra a `Invocation` com o `prompt`, o `usage` da invocação e o `sessionCostUsd`, soma `durationMs`/`usage`; ao sair de `running` sempre chama `verifyAfterStep` (violação → `ref_violation`, nada commitado, mensagem lista as refs), atualiza `createdBranches` e `branchAtEnd`; commit "concluído" em passo não interativo, `awaiting_input` em interativo, commit `WIP: passo <passo> com erro` em erro; `reply(runId, text)` e `advance(runId)` com `INVALID_STATE` se o passo atual não estiver em `awaiting_input`; `advance` roda `verifyAfterStep` antes do commit e, com violação, aplica `ref_violation` (awaiting_input → failed, sem commit, run `failed`); ao terminar grava `finishedAt`, `finalBranch`, libera o lock e emite `run.finished`; toda mudança grava o `run.json` e emite `run.updated` no mesmo tick
- [X] T057 [US1] Implementar `apps/server/src/http/routes/runs.ts` (parte US1): `POST /runs` (valida `StartRunRequestSchema`, carrega a esteira por `pipelineId` com `404` se ausente, chama `executor.start`, responde `201`), `GET /runs/active` (`200`/`204`), `GET /runs/:id`, `POST /runs/:id/reply` (`ReplyRequestSchema`, `202`), `POST /runs/:id/advance` (`202`); e `GET /pipelines` mínimo em `apps/server/src/http/routes/pipelines.ts` (lista, padrão primeiro) para a UI escolher a esteira padrão
- [X] T058 [US1] Ligar em `apps/server/src/main.ts` o `ClaudeCliRunner`, o `RunLock`, o `PipelineExecutor` e as rotas de runs; o `hello` do WebSocket passa a enviar o run ativo
- [X] T059 [P] [US1] Implementar `apps/web/src/components/RepoPicker.tsx`: campo de caminho, botão "Usar", lista de repositórios recentes (de `getSettings`), chamada a `inspectRepo` ao confirmar e exibição da branch atual ("A execução partirá de `<branch>`", FR-003a) ou dos problemas em português (`not_a_repo` → "A pasta não é um repositório Git", `dirty_worktree` → "Há alterações não commitadas", `merge_or_rebase_in_progress` → "Há merge/rebase em andamento", `detached_head` → "HEAD destacado: troque para uma branch", `path_not_found` → "Pasta não encontrada")
- [X] T060 [P] [US1] Implementar `apps/web/src/components/FeatureInput.tsx`: textarea no topo e botão "Enviar" desabilitado com descrição vazia após `trim`, repositório inválido ou run ativo, com aviso ao tentar enviar vazio (FR-003)
- [X] T061 [P] [US1] Implementar `apps/web/src/components/InteractiveReply.tsx`: textarea de resposta + botões "Responder" (desabilitado com texto vazio) e "Avançar", chamando `reply`/`advance`, visível só quando o passo atual está em `awaiting_input`
- [X] T062 [P] [US1] Implementar `apps/web/src/components/RunSummary.tsx`: resultado geral (concluída / com erro / interrompida), branch final e lista de branches criadas (FR-017), e os totais da execução via `computeRunTotals(run)` — duração total `mm:ss`, tokens de entrada/saída e custo em US$, ou "consumo indisponível" (FR-017a, Princípio VIII); os totais também aparecem com o run em andamento
- [X] T063 [US1] Montar `apps/web/src/pages/RunPage.tsx` (parte US1): `RepoPicker` + `FeatureInput` no topo; ao enviar, `startRun` com a esteira padrão (`listPipelines()[0]`) e `expectedBranch` = branch exibida; em `409 BRANCH_CHANGED`, atualizar a branch exibida com aviso e exigir novo clique em "Enviar" (FR-003a); lista simples dos passos com nome e status do `run-store`; `InteractiveReply` para o passo em `awaiting_input`; `RunSummary` ao fim; ao carregar, `getActiveRun` restaura o run em andamento; erros da API exibidos com a mensagem do servidor

**Checkpoint**: US1 funciona de ponta a ponta com o Claude Code real (quickstart, validação manual 1 e 5) e com o fake nos testes.

---

## Phase 4: User Story 2 - Acompanhar progresso e saída de cada passo em tempo real (Priority: P1)

**Goal**: caixas por passo com os seis status, duração e consumo, e saída de cada passo em streaming (≤ 2 s), consultável depois do fim e após reconectar.

**Independent Test**: iniciar uma execução e verificar que as caixas mudam de status com o progresso e que a saída do passo em execução aparece incrementalmente (quickstart, validação manual 2).

### Tests for User Story 2 ⚠️

- [X] T064 [P] [US2] Escrever testes em `apps/server/tests/unit/event-hub.test.ts` com `vi.useFakeTimers()`: `pushOutput(runId, stepIndex, entry)` agrupa entradas e emite um único `step.output` por passo a cada ≤ 250 ms; `flush()` emite imediatamente o pendente; `run.updated` emitido depois de saídas pendentes é precedido pelo `flush` dessas saídas (ordem preservada)
- [X] T065 [P] [US2] Escrever testes em `apps/server/tests/integration/output-api.test.ts`: `GET /api/runs/:id/steps/:index/output` devolve a saída completa e, com `?afterSeq=n`, só `seq > n`; índice fora do intervalo → `404`; durante um run com `FakeAgentRunner` que emite saídas espaçadas, o cliente WS recebe `step.output` antes de o passo terminar, e cada entrada chega em **≤ 2 s** depois do `onOutput` correspondente (medido com o relógio real entre a emissão do fake e a recepção no cliente; SC-003); cada `run.updated` de mudança de status chega em ≤ 2 s da transição (SC-004)
- [X] T066 [P] [US2] Escrever testes de componente em `apps/web/tests/pipeline-boxes.test.tsx`: `PipelineBoxes` renderiza uma caixa por passo com nome, modelo e skill/comando (FR-013); cada um dos seis status aparece com rótulo em português (aguardando, executando, aguardando resposta, concluído, com erro, interrompido; FR-014); caixa `failed` mostra `errorMessage`; caixa concluída mostra duração formatada e consumo (tokens e custo) quando presente, e "consumo indisponível" quando `usage` é nulo; clicar na caixa abre `StepOutputPanel`, que mostra a entrada do passo (entrada `system` "Entrada: …" destacada no topo, FR-016) e as entradas já recebidas, acrescenta novas do store sem recarregar, e trunca `tool_result` acima de 4 KB com opção "mostrar tudo"
- [X] T067 [P] [US2] Escrever testes em `apps/web/tests/ws-resync.test.ts`: após reconexão, para cada passo com saída o cliente chama `getStepOutput(runId, i, lastSeq[i])` e o store não duplica entradas

### Implementation for User Story 2

- [X] T068 [US2] Estender `apps/server/src/ws/event-hub.ts` com batching de saída: `pushOutput(runId, stepIndex, entry)` acumula e agenda `setTimeout` de 250 ms; `flush()`; `broadcast` de eventos `run.*` faz `flush` antes
- [X] T069 [US2] Ligar em `apps/server/src/execution/pipeline-executor.ts` cada `OutputEntry` gravada (incluindo `user_reply` e uma entrada `error` com a mensagem quando o passo falha) ao `eventHub.pushOutput`, mantendo a gravação no `.jsonl` antes do envio
- [X] T070 [US2] Implementar `GET /runs/:id/steps/:index/output?afterSeq=` em `apps/server/src/http/routes/runs.ts` usando `RunStore.readOutput` (`404 NOT_FOUND` para run ou índice inexistente)
- [X] T071 [US2] Implementar a ressincronização em `apps/web/src/api/ws.ts` e `apps/web/src/state/run-store.ts`: em cada `hello` após reconexão, buscar `getStepOutput(runId, i, lastSeq[i] ?? -1)` para os passos já iniciados e despachar as entradas; ao abrir um passo sem saída carregada, buscar a saída completa
- [X] T072 [P] [US2] Implementar `apps/web/src/components/StepBox.tsx`: nome, modelo, skill/comando, selo de status com cor por estado, badge "interativo", duração (`durationMs` formatado `mm:ss`) e consumo (`inputTokens`/`outputTokens` e `costUsd` em US$ quando presentes), `errorMessage` quando `failed`
- [X] T073 [P] [US2] Implementar `apps/web/src/components/StepOutputPanel.tsx`: lista de `OutputEntry` com estilo por `kind` (`text` corrido, `tool_use`/`tool_result` em bloco monoespaçado, `user_reply` destacado, `system` iniciada por "Entrada:" em bloco rotulado "Entrada enviada ao agente", `error` em vermelho), truncamento de `tool_result` em 4 KB com "mostrar tudo" (research R10) e rolagem automática enquanto o usuário estiver no fim
- [X] T074 [US2] Implementar `apps/web/src/components/PipelineBoxes.tsx` (sequência horizontal de `StepBox` com o passo selecionado) e trocar a lista simples de `apps/web/src/pages/RunPage.tsx` por `PipelineBoxes` + `StepOutputPanel` do passo selecionado (seleciona automaticamente o passo em execução); antes do envio, mostrar as caixas da esteira escolhida com todos os passos em "aguardando"; mostrar indicador de conexão "reconectando…"

**Checkpoint**: US1 + US2 entregam o MVP: executar a esteira padrão acompanhando tudo em tempo real.

---

## Phase 5: User Story 3 - Interromper uma execução (Priority: P2)

**Goal**: interromper a qualquer momento (inclusive em "aguardando resposta"), limite de tempo por invocação, encerramento da árvore de processos em ≤ 5 s, commit WIP, e encerramento/recuperação do servidor.

**Independent Test**: iniciar uma execução, interromper durante o segundo passo e verificar que o processo do agente sumiu, que o passo está "interrompido", que os passos seguintes ficaram "aguardando", que há commit WIP se houve alterações e que a branch de origem não mudou (quickstart, validações manuais 3, 4 e 8).

### Tests for User Story 3 ⚠️

- [X] T075 [P] [US3] Escrever teste de integração em `apps/server/tests/integration/kill-tree.test.ts`: iniciar `node` que inicia um `node` filho que dorme (com `detached` como no runner), chamar `killProcessTree(pid)` e verificar que pai e filho deixam de existir em < 5 s (no Windows via `tasklist /FI "PID eq <pid>"`, no POSIX via `process.kill(pid, 0)`)
- [X] T076 [P] [US3] Escrever testes em `apps/server/tests/unit/claude-cli-runner.test.ts` substituindo o binário por um script `node` falso (injeção do comando no construtor) que imprime linhas stream-json e dorme: abortar o `signal` resolve `interrupted` em < 5 s e não deixa o processo vivo; nenhum `onOutput` depois de resolver; script que sai com código 1 sem `result` → `error` com o fim do stderr; comando inexistente → `error` com a mensagem de "não encontrado no PATH"
- [X] T077 [P] [US3] Escrever testes em `apps/server/tests/unit/executor.test.ts` (grupo "US3") com `vi.useFakeTimers()` e `FakeAgentRunner`: `interrupt` em `running` → passo `interrupted` com `interruptReason: "user"`, commit `WIP: passo <passo> interrompido` se houver alterações e nenhum commit sem alterações, run `interrupted`, passos restantes `waiting`, lock liberado; `interrupt` em `awaiting_input` → `interrupted` com commit WIP; timeout dispara exatamente em `timeoutMinutes × 60 000` ms (não antes: avançar `limite − 1` não interrompe) com `interruptReason: "timeout"`; passo sem `timeoutMinutes` usa 30 min; a pausa em `awaiting_input` não conta (avançar 2 h em pausa não interrompe) e cada `reply` recebe o limite completo; `shutdown()` interrompe com `"server_shutdown"`, faz o commit WIP, persiste e só então resolve; `interrupt` em run terminal → `INVALID_STATE`; violação de refs num passo interrompido (o `sideEffect` do fake troca para a branch de origem), tanto em `running` quanto em `awaiting_input` → passo **continua `interrupted`**, nenhum commit, `errorMessage` lista a violação, run `interrupted` (FR-011a, data-model.md)
- [X] T078 [P] [US3] Escrever testes em `apps/server/tests/unit/recovery.test.ts`: `recoverInterruptedRuns(runStore)` marca como `interrupted` todo `run.json` em `running`/`awaiting_input`, o passo não terminal como `interrupted` com `interruptReason: "server_shutdown"`, grava `finishedAt`, e não altera runs terminais
- [X] T079 [P] [US3] Escrever testes de componente em `apps/web/tests/interrupt.test.tsx`: botão "Interromper" visível e habilitado em `running` e `awaiting_input`, ausente em estado terminal, chama `interrupt`; caixa `interrupted` mostra "interrompido" e o motivo ("pelo usuário", "tempo limite excedido", "aplicação encerrada")

### Implementation for User Story 3

- [X] T080 [P] [US3] Implementar `apps/server/src/agent/kill-tree.ts`: `killProcessTree(pid)` com `taskkill /PID <pid> /T /F` no Windows e, no POSIX, `process.kill(-pid, "SIGTERM")` seguido de `SIGKILL` se não sair em 2 s (research R5); erros de processo já encerrado são ignorados
- [X] T081 [US3] Tratar `signal` em `apps/server/src/agent/claude-cli-runner.ts`: ao abortar (ou se já abortado antes do `spawn`), chamar `killProcessTree(child.pid)`, parar de repassar `onOutput` e resolver `interrupted` quando o processo sair ou após 4 s, o que vier primeiro; aceitar o comando do binário por injeção no construtor para os testes de T076
- [X] T082 [US3] Implementar em `apps/server/src/execution/pipeline-executor.ts`: um `AbortController` por invocação com `setTimeout(() => controller.abort("timeout"), (step.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000)` e `clearTimeout` ao fim (não usar `AbortSignal.timeout`, research R4); `interrupt(runId)` (aborta com `"user"` em `running`; em `awaiting_input` transita direto para `interrupted`); `shutdown()` (aborta com `"server_shutdown"` e aguarda o commit WIP e a persistência); `interruptReason` vem de `signal.reason`; após interrupção (em `running` ou `awaiting_input`), verificação de refs e commit `WIP: passo <passo> interrompido` se ela passar; se falhar, o passo continua `interrupted`, nada é commitado e a violação vai para `errorMessage`; FR-019: nenhuma reexecução automática
- [X] T083 [US3] Implementar `POST /runs/:id/interrupt` em `apps/server/src/http/routes/runs.ts` (`202`; `409 INVALID_STATE` se o run não estiver em `running`/`awaiting_input`; `404` se não existir)
- [X] T084 [US3] Implementar `apps/server/src/execution/recovery.ts` com `recoverInterruptedRuns(runStore)` conforme T078 e chamá-la em `apps/server/src/main.ts` antes do `listen`; em `main.ts`, tratar `SIGINT`/`SIGTERM` chamando `executor.shutdown()` e só então fechar o WebSocket e o `http.Server` (research R8, plan "Shutdown")
- [X] T085 [US3] Adicionar o botão "Interromper" em `apps/web/src/pages/RunPage.tsx` (visível em `running`/`awaiting_input`, chama `interrupt`, desabilita até o `run.updated` seguinte) e o motivo da interrupção em `apps/web/src/components/StepBox.tsx` (`user` → "interrompido pelo usuário", `timeout` → "tempo limite excedido", `server_shutdown` → "aplicação encerrada")

**Checkpoint**: interromper e timeout encerram o agente em ≤ 5 s, deixam o repositório limpo e a esteira parada.

---

## Phase 6: User Story 6 - Decidir permissões do agente ou rodar em Modo Yolo (Priority: P2)

**Goal**: checkbox "Modo Yolo" desmarcado por padrão; sem ele, cada uso de ferramenta que a CLI não aprova sozinha vira um pedido de permissão em tempo real (permitir uma vez, permitir sempre nesta execução, negar), com o timer pausado durante a espera (FR-027–FR-032, research R13).

**Independent Test**: quickstart, validação manual 10.

**Detalhamento técnico** (interfaces, assinaturas, testes e valores exatos): [`docs/superpowers/plans/2026-11-17-modo-yolo-permissoes.md`](../../docs/superpowers/plans/2026-11-17-modo-yolo-permissoes.md). Cada tarefa abaixo corresponde a uma Task do plano. Depende de US2 (T072 `StepBox`) e de US3 (T080–T085: `killProcessTree`, `interrupt`, `shutdown`, timer por invocação e `recoverInterruptedRuns`).

- [ ] T105 [US6] Verificar na CLI real (manual, `haiku`): quanto tempo ela espera a resposta de `tools/call` (e o ajuste por variável de ambiente, se necessário) e se `--permission-mode bypassPermissions` respeita `--disallowedTools`; registrar em research R13 as decisões `PERMISSION_ENV` e `YOLO_PERMISSION_MODE` (plano, Task 2)
- [ ] T106 [P] [US6] Testes e implementação em `packages/shared`: `awaiting_permission` em `RunStatus`/`StepStatus`, `PermissionRequestSchema`, `Run.yolo`, `Run.permissionRules`, `StepRun.permissionRequests` (com `.default`), `StartRunRequest.yolo`, `PermissionDecisionRequestSchema`, e `src/permission-rules.ts` (`deriveRule`, `matchesRule`, `summarizeToolInput` movido do parser) (plano, Task 3)
- [ ] T107 [US6] Testes e implementação dos eventos `permission_request`/`permission_decision` em `apps/server/src/execution/state-machine.ts`, de `apps/server/src/execution/pausable-timer.ts` (`createPausableTimer`) e do tratamento de `awaiting_permission` em `recoverInterruptedRuns` (plano, Task 4)
- [ ] T108 [US6] Testes e implementação de `permissionChannel` em `AgentInvocation`, dos argumentos por modo em `apps/server/src/agent/permissions.ts`, do relay MCP stdio `apps/server/permission-relay/relay.mjs` (com `node:http`, falha fechada) e de `apps/server/src/agent/relay-path.ts` (plano, Task 5)
- [ ] T109 [US6] Testes e implementação de `apps/server/src/execution/permission-broker.ts` (`PermissionBroker`) e da rota `POST /internal/permission-requests` em `apps/server/src/http/routes/internal.ts`, com token por invocação e origin guard (plano, Task 6)
- [ ] T110 [US6] Testes (grupo "US6" em `apps/server/tests/unit/executor.test.ts`) e implementação no `PipelineExecutor`: canal por invocação fora do Yolo, `PermissionRequest` com saída `system`, `awaiting_permission` com timer pausado, regras de "permitir sempre", pedidos paralelos, `decidePermission`, interrupção com pedidos pendentes; `FakeAgentRunner` com `permissionRequests` (plano, Task 7)
- [ ] T111 [US6] Testes em `apps/server/tests/integration/runs-api.test.ts` e implementação de `yolo` em `POST /runs`, de `POST /runs/:id/permissions/:requestId` e de `interrupt` em `awaiting_permission` (plano, Task 8)
- [ ] T112 [US6] Testes em `apps/web/tests/permissions.us6.test.tsx` e implementação do checkbox Modo Yolo em `FeatureInput`, de `apps/web/src/components/PermissionPrompt.tsx`, de `decidePermission` em `client.ts`, dos rótulos "aguardando permissão" e do indicador Yolo e da lista de pedidos no `RunSummary` (plano, Task 9)
- [ ] T113 [US6] Executar a validação manual 10 do quickstart com a CLI real e registrar o resultado em `validation.md` (plano, Task 10)

**Checkpoint**: com o Modo Yolo desmarcado, nenhum comando não aprovado pela CLI roda sem decisão do usuário (SC-009); com ele marcado, nenhum pedido aparece; os bloqueios de git valem nos dois modos.

---

## Phase 7: User Story 4 - Criar, editar, reordenar e salvar esteiras personalizadas (Priority: P3)

**Goal**: editor de esteiras sobre o JSON (criar, editar, adicionar/remover/reordenar passos, salvar, duplicar, excluir) e escolha da esteira antes de enviar.

**Independent Test**: criar a esteira "Mini" com dois passos (Specify e Plan), salvar, reiniciar o servidor, selecioná-la e executá-la num repositório de teste (quickstart, validação manual 6).

### Tests for User Story 4 ⚠️

- [ ] T086 [P] [US4] Escrever testes em `apps/server/tests/integration/pipelines-api.test.ts`: `GET /api/pipelines` com a padrão primeiro e as demais por nome; `GET /api/pipelines/:id` e `404`; `POST /api/pipelines` → `201` com `id`, ids de passo gerados quando ausentes, `isDefault: false`, `createdAt`/`updatedAt`; corpo inválido → `400 VALIDATION_FAILED` com `issues` da tabela de contracts/pipeline-definition.md; nome repetido → `400` com `issues[0].path = ["name"]`; `PUT` atualiza mantendo `id`/`createdAt` e renova `updatedAt`, e preserva a ordem do array; `POST /:id/duplicate` → `201` com nome "<nome> (cópia)" e `isDefault: false`; `DELETE` → `204` e `409 INVALID_STATE` na padrão; com um arquivo inválido gravado direto no data dir, `GET /api/pipelines` o omite e `GET /api/pipelines/:id` → `422 PIPELINE_INVALID` com `issues`; após reiniciar o servidor no mesmo data dir, a esteira salva continua listada (FR-025); `POST /api/runs` com esteira inválida no disco é recusado (FR-024)
- [ ] T087 [P] [US4] Escrever testes de componente em `apps/web/tests/pipeline-editor.test.tsx`: adicionar passo e preencher nome, modelo, skill/comando, interativo e limite; remover passo; mover passo para cima/baixo e ver a nova ordem nas caixas; salvar chama `createPipeline`/`updatePipeline`; erros de validação (local, com `PipelineInputSchema`, e do servidor) aparecem ao lado do campo indicado por `path`; "Duplicar" e "Excluir" (com confirmação, ausente na padrão); `PipelineSelector` na RunPage lista as esteiras e lembra a última escolhida

### Implementation for User Story 4

- [ ] T088 [US4] Completar `apps/server/src/http/routes/pipelines.ts`: `GET /pipelines/:id`, `POST /pipelines`, `PUT /pipelines/:id`, `POST /pipelines/:id/duplicate`, `DELETE /pipelines/:id` conforme contracts/rest-api.md, validando com `PipelineInputSchema`, gerando ids com `crypto.randomUUID()`, checando nome único via `PipelineStore.nameExists` (mensagem "Já existe uma esteira com este nome", `path: ["name"]`) e impedindo excluir a padrão
- [ ] T089 [US4] Em `apps/server/src/execution/pipeline-executor.ts`, revalidar a esteira com `PipelineSchema` antes de `start` (FR-024) e, em `POST /runs`, gravar `lastPipelineId` no `SettingsStore`
- [ ] T090 [P] [US4] Implementar `apps/web/src/components/PipelineSelector.tsx`: `<select>` das esteiras salvas, inicializado com `settings.lastPipelineId` ou a padrão, e integrá-lo em `apps/web/src/pages/RunPage.tsx` (as caixas pré-envio mostram a esteira escolhida; o envio usa o `pipelineId` selecionado) (FR-022)
- [ ] T091 [P] [US4] Implementar `apps/web/src/components/StepEditor.tsx`: campos `name` (1–60), `model` (input com sugestões `opus`, `sonnet`, `haiku`), `command`, checkbox `interactive`, `timeoutMinutes` opcional (1–1440, vazio = padrão 30), botões mover para cima/baixo e remover, e mensagens de erro por campo
- [ ] T092 [US4] Implementar `apps/web/src/pages/PipelineEditorPage.tsx`: lista de esteiras à esquerda (Nova, Duplicar, Excluir) e editor à direita com o nome da esteira, os `StepEditor` na ordem do array, "Adicionar passo", pré-visualização com `PipelineBoxes` e "Salvar"; o estado do editor é apenas um `PipelineInput` (Princípio IV); valida com `PipelineInputSchema` antes de enviar e mapeia `issues[].path` para os campos

**Checkpoint**: esteiras personalizadas criadas, salvas, persistidas e executadas.

---

## Phase 8: User Story 5 - Consultar execuções anteriores (Priority: P3)

**Goal**: histórico do mais recente para o mais antigo, e abertura de qualquer execução em modo somente leitura na mesma visualização de caixas.

**Independent Test**: executar duas esteiras (uma concluída e uma interrompida), reiniciar o servidor, abrir o histórico e verificar a ordem e a saída de cada passo, sem opções de editar ou reexecutar (quickstart, validação manual 7).

### Tests for User Story 5 ⚠️

- [ ] T093 [P] [US5] Escrever testes em `apps/server/tests/integration/history-api.test.ts`: `GET /api/runs` → `RunSummary[]` ordenado por `startedAt` decrescente com `pipelineName`, `descriptionPreview` truncada em 120 caracteres, `status`, `finalBranch`, `totalDurationMs` e `totalUsage` iguais a `computeRunTotals` do run (e `totalUsage: null` quando nenhum passo reportou consumo); lista vazia → `[]`; após reiniciar o servidor no mesmo data dir os runs continuam listados e `GET /runs/:id/steps/:i/output` devolve a saída completa (SC-008); `run.json` corrompido é ignorado na listagem com log de aviso
- [ ] T094 [P] [US5] Escrever testes de componente em `apps/web/tests/history.test.tsx`: `HistoryPage` mostra data, repositório, esteira, início da descrição, status final, branch do resultado, duração total e consumo total (ou "indisponível"); lista vazia mostra "Ainda não há execuções"; selecionar um run abre `RunView` em modo somente leitura com caixas, entrada, saída, respostas, erros, duração e consumo de cada passo e os totais da execução, e sem botões de enviar, responder, avançar, interromper, editar ou reexecutar

### Implementation for User Story 5

- [ ] T095 [US5] Implementar `GET /runs` em `apps/server/src/http/routes/runs.ts` usando `RunStore.listAll()` mapeado para `RunSummary` (`descriptionPreview` = primeiros 120 caracteres; `totalDurationMs`/`totalUsage` de `computeRunTotals`), ordenado por `startedAt` decrescente, ignorando arquivos inválidos com `console.warn`
- [ ] T096 [US5] Extrair de `apps/web/src/pages/RunPage.tsx` um componente `apps/web/src/components/RunView.tsx` (`PipelineBoxes` + `StepOutputPanel` + `RunSummary` com os totais da execução (FR-017a), com a entrada e as respostas do passo listadas no painel) com prop `readOnly` que oculta `InteractiveReply` e "Interromper"; no modo somente leitura a saída é carregada por `getStepOutput` (sem WebSocket)
- [ ] T097 [US5] Implementar `apps/web/src/pages/HistoryPage.tsx`: tabela de `listRuns()` com as colunas de FR-016a (incluindo duração total e consumo total de `totalDurationMs`/`totalUsage`) e estado vazio; ao clicar, `getRun(id)` e `RunView readOnly`, com botão "Voltar ao histórico"

**Checkpoint**: todas as histórias funcionam de forma independente.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: build de produção, documentação e validação final

- [ ] T098 Servir o build estático de `apps/web/dist` em `apps/server/src/http/app.ts` quando ele existir (fallback para `index.html` em rotas que não começam com `/api`), para que `npm run build && npm start` abra a UI em `http://127.0.0.1:4317` (research R7)
- [ ] T099 [P] Adicionar *smoke test* opcional em `apps/server/tests/integration/claude-smoke.test.ts`, pulado a menos que `RUN_CLAUDE_SMOKE=1`: roda `ClaudeCliRunner` com `"responda apenas: ok"`, modelo `haiku`, num repositório temporário, e verifica `success` com `usage` preenchido
- [ ] T100 [P] Revisar mensagens de erro acionáveis (Princípio VI) em `apps/server/src/git/git-service.ts`, `apps/server/src/agent/claude-cli-runner.ts` e `apps/server/src/execution/pipeline-executor.ts`: todas em português, citando o que fazer (ex.: "Faça commit ou descarte as alterações antes de executar")
- [ ] T101 [P] Escrever `README.md` na raiz com pré-requisitos, comandos (`npm install`, `npm run dev`, `npm test`, `npm run build`, `npm start`), variáveis `ORCHESTRATOR_PORT`/`ORCHESTRATOR_DATA_DIR`/`RUN_CLAUDE_SMOKE`, local da pasta de dados e as garantias de segurança de branch
- [ ] T102 Verificar que nenhum `any` foi usado sem comentário justificando (Princípio VII) com uma busca por `: any`/`as any` em `apps/` e `packages/`, e corrigir ou justificar
- [ ] T103 Rodar `npm run typecheck`, `npm test` e `npm run build` na raiz e corrigir qualquer falha
- [ ] T104 Executar as validações manuais 1–9 de [quickstart.md](./quickstart.md) contra um repositório de teste com Spec Kit e registrar os resultados em `specs/001-agent-pipeline-orchestrator/validation.md`, cronometrando: no item 1, do carregamento da página até o clique em "Enviar" (SC-002: < 1 min); no item 6, da abertura do editor até salvar uma esteira de 3 passos (SC-007: < 3 min)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende do Setup e **bloqueia todas as histórias**
- **US1 (Phase 3)**: depende da Phase 2
- **US2 (Phase 4)**: depende da Phase 2; integra-se ao executor e à RunPage de US1 (T069 e T074 alteram arquivos de US1), por isso na prática vem depois de US1
- **US3 (Phase 5)**: depende de US1 (estende `claude-cli-runner.ts` e `pipeline-executor.ts`); independe de US2
- **US6 (Phase 6)**: depende de US2 (T072) e de US3 (T080–T085); T110 e T111 estendem executor e rotas de US1/US3
- **US4 (Phase 7)**: depende da Phase 2 para as rotas e o editor; T089/T090 tocam executor e RunPage de US1
- **US5 (Phase 8)**: depende de US2 (reutiliza `PipelineBoxes`, `StepOutputPanel` e a rota de saída)
- **Polish (Phase 9)**: depende das histórias desejadas

### User Story Dependencies

```text
Setup → Foundational ─┬─► US1 ─┬─► US2 ──► US5
                      │        ├─► US3 ──► US6 (também depende de US2)
                      │        └─► US4 (T089/T090)
                      └─► US4 (T086–T088, T091–T092 podem começar já)
```

### Within Each User Story

- Testes primeiro, falhando antes da implementação (Princípio VII)
- Módulos puros (parser, permissões, lookup) antes do runner; runner e lock antes do executor; executor antes das rotas; rotas antes da UI
- História concluída e verificada antes de seguir para a próxima prioridade

### Parallel Opportunities

- Setup: T003, T004, T005 e T006 em paralelo
- Foundational: os testes T008, T009, T016, T022–T024, T028, T032, T040 em paralelo; os schemas T010–T013 em paralelo; T017, T018, T021, T025, T026, T029, T030, T031, T033, T034, T038, T039 em paralelo
- US1: os testes T043–T049 em paralelo; T050–T053 e T055 em paralelo; os componentes T059–T062 em paralelo
- US2: os testes T064–T067 em paralelo; T072 e T073 em paralelo
- US3: os testes T075–T079 em paralelo; T080 em paralelo com os testes
- US4: T086 e T087 em paralelo; T090 e T091 em paralelo; T086–T088 e T091–T092 podem correr ao lado de US2/US3
- US5: T093 e T094 em paralelo
- US6: T106 pode começar junto com T105; as demais seguem em ordem (cada uma usa as interfaces da anterior)

---

## Parallel Example: User Story 1

```bash
# Testes de US1 juntos:
Task: "Fixtures stream-json em apps/server/tests/fixtures/stream-json/"
Task: "Testes do parser em apps/server/tests/unit/stream-json-parser.test.ts"
Task: "Testes de argumentos/permissões em apps/server/tests/unit/permissions.test.ts"
Task: "Testes de lookup de comando em apps/server/tests/unit/command-lookup.test.ts"
Task: "Testes do executor (US1) em apps/server/tests/unit/executor.test.ts"
Task: "Testes da API de runs em apps/server/tests/integration/runs-api.test.ts"
Task: "Testes de componentes em apps/web/tests/run-page.us1.test.tsx"

# Módulos puros de US1 juntos:
Task: "stream-json-parser em apps/server/src/agent/stream-json-parser.ts"
Task: "NON_INTERACTIVE_SYSTEM_PROMPT em apps/server/src/agent/system-prompts.ts"
Task: "permissões e buildClaudeArgs em apps/server/src/agent/permissions.ts"
Task: "commandExists em apps/server/src/agent/command-lookup.ts"
Task: "RunLock em apps/server/src/execution/run-lock.ts"

# Componentes de US1 juntos:
Task: "RepoPicker em apps/web/src/components/RepoPicker.tsx"
Task: "FeatureInput em apps/web/src/components/FeatureInput.tsx"
Task: "InteractiveReply em apps/web/src/components/InteractiveReply.tsx"
Task: "RunSummary em apps/web/src/components/RunSummary.tsx"
```

## Parallel Example: User Story 3

```bash
Task: "Teste de kill-tree em apps/server/tests/integration/kill-tree.test.ts"
Task: "Testes do runner com binário falso em apps/server/tests/unit/claude-cli-runner.test.ts"
Task: "Testes do executor (US3) em apps/server/tests/unit/executor.test.ts"
Task: "Testes de recuperação em apps/server/tests/unit/recovery.test.ts"
Task: "Testes do botão Interromper em apps/web/tests/interrupt.test.tsx"
Task: "killProcessTree em apps/server/src/agent/kill-tree.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2, ambas P1)

1. Phase 1: Setup
2. Phase 2: Foundational (bloqueia tudo)
3. Phase 3: US1 → **validar**: quickstart, validações 1 e 5
4. Phase 4: US2 → **validar**: quickstart, validação 2
5. Parar e usar: a esteira padrão roda de ponta a ponta com acompanhamento em tempo real

US1 sozinha já é testável (resultado no git, status das caixas via `run.updated`), mas o critério de sucesso da spec e o Princípio VI pedem a saída em tempo real, por isso o MVP inclui US2.

### Incremental Delivery

1. Setup + Foundational → base pronta (incrementos 1, 2 e parte do 4–5 do plano)
2. US1 → esteira padrão executa (incrementos 3–6)
3. US2 → transparência em tempo real
4. US3 → controle de custo: interromper, timeout, shutdown (Princípio VIII)
5. US6 → pedidos de permissão em tempo real e Modo Yolo
6. US4 → esteiras personalizadas (incremento 7)
7. US5 → histórico (incremento 7)
8. Polish → build de produção e validação final

Cada incremento termina com `npm run typecheck` e `npm test` verdes e com o sistema funcionando (Princípio V).

---

## Notes

- [P] = arquivos diferentes, sem dependência de tarefa incompleta
- [USn] liga a tarefa à história para rastreabilidade
- Nunca enfraquecer ou desabilitar testes para passar (Princípio VII)
- Commit após cada tarefa ou grupo lógico
- Testes de git e do executor usam repositórios temporários e `ORCHESTRATOR_DATA_DIR` temporário: nunca tocam o repositório do projeto nem a pasta de dados real
- Os testes nunca invocam o `claude` real, exceto o *smoke test* opcional (T099); T105 e T113 são verificações manuais com a CLI real
