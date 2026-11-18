# Modo Yolo e pedidos de permissão — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** checkbox "Modo Yolo" (desligado por padrão) e, com ele desligado, pedidos de permissão em tempo real que o usuário decide na interface (permitir uma vez, permitir sempre nesta execução, negar).

**Architecture:** com Yolo desligado, a CLI recebe `--permission-prompt-tool mcp__orchestrator__approve` e um servidor MCP stdio próprio (`permission-relay/relay.mjs`) que repassa cada pedido por HTTP ao orquestrador (`POST /internal/permission-requests`, com token por invocação). O `PermissionBroker` liga o token à invocação; o executor registra o pedido no `StepRun`, pausa o passo em `awaiting_permission` (com o timer pausado) e devolve a decisão quando o usuário clica. Tudo falha fechado (nega).

**Tech Stack:** TypeScript strict, Node 24, Express 5, Zod 4, Vitest, React 19 — sem dependência nova.

**Spec:** [`docs/superpowers/specs/2026-11-17-modo-yolo-permissoes-design.md`](../specs/2026-11-17-modo-yolo-permissoes-design.md) e, depois da Task 1, `specs/001-agent-pipeline-orchestrator/` (spec, research R13, data-model, contracts, tasks Fase 6).

**Pré-requisito:** Fases 4 (US2) e 5 (US3) concluídas. A Task 1 pode ser feita já; as Tasks 2–10 só depois da Fase 5, porque usam `killProcessTree`, `interrupt`, `shutdown`, o timer por invocação (T082), `recoverInterruptedRuns` (T084) e `StepBox` (T072).

## Global Constraints

- Quality gate de cada task: `npm run typecheck` e `npm test` verdes na raiz.
- Nenhuma dependência nova (Princípio III): relay com JSON-RPC à mão, HTTP com `node:http`.
- Os testes nunca chamam o `claude` real; só a Task 2 e a Task 10 (manuais) chamam.
- Nos dois modos valem `DISALLOWED_TOOLS` (git) e `verifyAfterStep` (FR-011a, Princípio II).
- Falha fechada: qualquer erro no canal de permissão → `{ behavior: "deny", message }`.
- Nome da ferramenta: `mcp__orchestrator__approve` (servidor `orchestrator`, ferramenta `approve`).
- Cabeçalho do token: `X-Orchestrator-Token`. Variáveis do relay: `ORCHESTRATOR_PERMISSION_URL`, `ORCHESTRATOR_PERMISSION_TOKEN`.
- Textos de interface (exatos): checkbox "Modo Yolo: o agente executa qualquer comando sem perguntar"; aviso "Com o Modo Yolo, o agente roda comandos na sua máquina sem pedir confirmação. Os bloqueios de git continuam valendo."; botões "Permitir uma vez", "Permitir sempre `<regra>` nesta execução", "Negar"; status do passo "aguardando permissão"; status do run "Aguardando permissão".
- `run.json` antigos continuam válidos: campos novos com `.default(...)`, `schemaVersion` continua `1`.

## Review Focus

1. **Dois pedidos em paralelo** (o agente chama duas ferramentas ao mesmo tempo): o passo só volta a `running` quando os dois forem decididos. Teste na Task 7.
2. **Interromper com pedido pendente**: a CLI recebe `deny`, o processo é encerrado, o passo fica `interrupted` e o pedido vira `cancelled`. Teste na Task 7.
3. **Servidor reiniciado com pedido pendente**: `recoverInterruptedRuns` trata `awaiting_permission` como não terminal e marca os pendentes como `cancelled`. Teste na Task 7.
4. **Duplo clique em "Permitir"**: a segunda decisão recebe `409 INVALID_STATE` e não gera uma segunda resposta à CLI. Teste na Task 8.
5. **Pedido com token de invocação já encerrada** (ou sem token): é negado na hora e nunca pausa o run. Teste na Task 6.

---

### Task 1: Atualizar os artefatos do Spec Kit

**Files:**
- Modify: `specs/001-agent-pipeline-orchestrator/spec.md`, `research.md`, `data-model.md`, `contracts/rest-api.md`, `contracts/agent-runner.md`, `quickstart.md`, `tasks.md`

- [ ] **Step 1: spec.md** — nova "User Story 6 - Decidir permissões do agente ou rodar em Modo Yolo (Priority: P2)" depois da US3, com cenários de aceite (pedido aparece e espera; permitir uma vez; permitir sempre não pergunta de novo o mesmo prefixo; negar não executa; Yolo não pergunta; interromper com pedido pendente). FRs novos: **FR-027** checkbox Yolo por envio, desligado por padrão, gravado na execução; **FR-028** com Yolo desligado, uso de shell não aprovado pela CLI gera pedido e pausa em "aguardando permissão" até a decisão; **FR-029** três decisões e regra derivada exibida antes do clique; **FR-030** pedidos e decisões no histórico; **FR-031** falha no canal = negar; **FR-032** a espera pela decisão não conta para FR-018a. Edge cases: comandos somente leitura aprovados pela própria CLI sem pedido; pedidos simultâneos.
- [ ] **Step 2: research.md** — **R13** com o spike do design (seção "Validação feita"), a decisão do relay stdio e o `node:http` no relay (o `fetch` do Node tem `headersTimeout` de 300 s e cortaria esperas longas). Em R3, nota de que `Bash`/`PowerShell` em `ALLOWED_TOOLS` passam a valer só no Yolo.
- [ ] **Step 3: data-model.md** — `PermissionRequest`, `Run.yolo`, `Run.permissionRules`, `StepRun.permissionRequests`, estado `awaiting_permission` nas tabelas `StepStatus`/`RunStatus` (transições da Task 4).
- [ ] **Step 4: contracts** — rest-api: `yolo` em `POST /runs`, `POST /runs/:id/permissions/:requestId`, `POST /internal/permission-requests`, `awaiting_permission` nos `409 INVALID_STATE` de `interrupt`. agent-runner: `permissionChannel` em `AgentInvocation`, argumentos por modo, relay.
- [ ] **Step 5: quickstart.md** — validação manual 10 (Task 10).
- [ ] **Step 6: tasks.md** — inserir "Phase 6: User Story 6" depois da Phase 5 (renumerar US4→7, US5→8, Polish→9 e as referências em "Dependencies & Execution Order"; US6 depende de US2 e US3), com as tarefas **T105–T113** = Tasks 2–10 deste plano, na mesma ordem, citando este arquivo.
- [ ] **Step 7: Commit** — `git commit -m "docs: especifica Modo Yolo e pedidos de permissão (US6)"`

### Task 2 (T105): Verificações na CLI real

**Files:** Modify: `specs/001-agent-pipeline-orchestrator/research.md` (R13)

Manual, com `haiku`, reaproveitando o relay do spike (scratchpad) com um atraso configurável.

- [ ] **Step 1:** atraso de 6 min antes de responder `allow` a `tools/call`. Registrar se a CLI esperou ou desistiu e após quanto tempo. Se desistiu, repetir com `MCP_TOOL_TIMEOUT=86400000` no ambiente do `claude` e registrar.
- [ ] **Step 2:** `--permission-mode bypassPermissions` + `--disallowedTools "Bash(git tag:*)"` com um prompt que pede `git tag x` e outro que pede `WebFetch`. Registrar se o `git tag` foi bloqueado.
- [ ] **Step 3:** registrar em R13 as decisões: `PERMISSION_ENV` (variáveis extras do `spawn`, ou `{}`) e `YOLO_PERMISSION_MODE` (`"bypassPermissions"` se o Step 2 bloqueou o `git tag`; senão `"acceptEdits"` com os argumentos de hoje). Se a CLI tiver um limite de espera intransponível, registrar o valor; a Task 7 trata o `deny` resultante como pedido `cancelled` com a mensagem "A CLI desistiu de esperar pela decisão".
- [ ] **Step 4: Commit** do research.

### Task 3 (T106): Schemas compartilhados e regras de permissão

**Files:**
- Modify: `packages/shared/src/schemas/run.ts`, `packages/shared/src/schemas/api.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/permission-rules.ts`
- Test: `packages/shared/tests/run.schema.test.ts`, `packages/shared/tests/permission-rules.test.ts`

**Interfaces:**
- Produces (em `run.ts`): `RunStatusSchema` e `StepStatusSchema` com `"awaiting_permission"`; `PermissionRequestStatusSchema = z.enum(["pending","allowed_once","allowed_always","denied","auto_allowed","cancelled"])`; `PermissionRequestSchema = { id: uuid, toolUseId: string, toolName: string, input: z.record(z.string(), z.unknown()), summary: string, status, rule: string | null, requestedAt: iso, decidedAt: iso | null }`; `StepRun.permissionRequests` (`.default([])`); `Run.yolo` (`.default(false)`); `Run.permissionRules: string[]` (`.default([])`).
- Produces (em `api.ts`): `StartRunRequest.yolo` (`.default(false)`); `PermissionDecisionSchema = z.enum(["allow_once","allow_always","deny"])`; `PermissionDecisionRequestSchema = { decision }`.
- Produces (em `permission-rules.ts`): `deriveRule(toolName: string, input: Record<string, unknown>): string`; `matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean`; `summarizeToolInput(input: unknown): string` (movido de `apps/server/src/agent/stream-json-parser.ts`, que passa a importá-lo daqui).

- [ ] **Step 1: testes que falham**

```ts
// permission-rules.test.ts
expect(deriveRule("Bash", { command: "npm test -- --run" })).toBe("Bash(npm test:*)");
expect(deriveRule("Bash", { command: "  make  " })).toBe("Bash(make:*)");
expect(deriveRule("PowerShell", { command: "Get-ChildItem -Recurse" })).toBe("PowerShell(Get-ChildItem -Recurse:*)");
expect(deriveRule("WebFetch", { url: "https://x" })).toBe("WebFetch");
expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test -- --watch=false" })).toBe(true);
expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm testx" })).toBe(false);
expect(matchesRule("Bash(npm test:*)", "PowerShell", { command: "npm test" })).toBe(false);
expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test; rm -rf /" })).toBe(false); // separadores de shell nunca casam
expect(matchesRule("WebFetch", "WebFetch", { url: "https://y" })).toBe(true);
// run.schema.test.ts: run.json sem yolo/permissionRules/permissionRequests → defaults false/[]/[];
// StepStatus e RunStatus aceitam "awaiting_permission"; StartRunRequest sem yolo → false.
```

- [ ] **Step 2:** `npm test -w packages/shared` → FAIL (módulo/campos inexistentes).
- [ ] **Step 3: implementar.** Regra: os dois primeiros tokens do comando separados por espaço em branco (só um se houver um). `matchesRule` para shell: o comando, depois de `trim`, é igual ao prefixo ou começa com `prefixo + " "`, **e** não contém `;`, `&&`, `||`, `|`, `` ` ``, `$(` nem quebra de linha.
- [ ] **Step 4:** `npm run typecheck` e `npm test` → PASS. Ajustar os construtores de `Run`/`StepRun` nos testes existentes que o typecheck apontar.
- [ ] **Step 5: Commit** — `feat(shared): schemas de permissão e regras derivadas`

### Task 4 (T107): Máquina de estados e timer pausável

**Files:**
- Modify: `apps/server/src/execution/state-machine.ts`, `apps/server/src/execution/recovery.ts` (T084)
- Create: `apps/server/src/execution/pausable-timer.ts`
- Test: `apps/server/tests/unit/state-machine.test.ts`, `apps/server/tests/unit/pausable-timer.test.ts`, `apps/server/tests/unit/recovery.test.ts`

**Interfaces:**
- Produces: `StepEvent` com `"permission_request"` e `"permission_decision"`; `createPausableTimer(ms: number, onFire: () => void): { pause(): void; resume(): void; clear(): void; remainingMs(): number }`.

- [ ] **Step 1: testes que falham** — `running --permission_request→ awaiting_permission`; `awaiting_permission --permission_request→ awaiting_permission`; `awaiting_permission --permission_decision→ running`; `awaiting_permission --interrupt/shutdown→ interrupted`; `awaiting_permission` com `timeout`, `reply`, `advance`, `agent_success` → `InvalidTransition`; `transitionRun(running, "awaiting_permission")` → `awaiting_permission` e de volta → `running`. Timer com `vi.useFakeTimers()`: 10 000 ms, avança 4 000, `pause()`, avança 60 000 sem disparar, `resume()`, avança 5 999 sem disparar, avança 1 → dispara uma vez; `clear()` impede o disparo. Recovery: run em `awaiting_permission` vira `interrupted` com pendentes `cancelled`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar as transições, o timer (guarda o instante de início; `pause` cancela o `setTimeout` e guarda o restante) e o recovery.
- [ ] **Step 4:** rodar → PASS. **Step 5: Commit.**

### Task 5 (T108): Argumentos da CLI por modo e relay MCP

**Files:**
- Modify: `apps/server/src/agent/agent-runner.ts`, `apps/server/src/agent/permissions.ts`, `apps/server/src/agent/claude-cli-runner.ts`
- Create: `apps/server/permission-relay/relay.mjs` (fora de `src`, para rodar com `node` puro em dev e produção), `apps/server/src/agent/relay-path.ts`
- Test: `apps/server/tests/unit/permissions.test.ts`, `apps/server/tests/unit/permission-relay.test.ts`

**Interfaces:**
- Produces: `PermissionChannel = { url: string; token: string }`; `AgentInvocation.permissionChannel: PermissionChannel | null` (`null` = Yolo); `PERMISSION_TOOL = "mcp__orchestrator__approve"`; `buildClaudeArgs(invocation, relay?: { command: string; args: string[] })`; `relayCommand(): { command: string; args: string[] }` (`process.execPath` + caminho de `relay.mjs` resolvido por `new URL("../../permission-relay/relay.mjs", import.meta.url)`); `RelayDecision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }`.
- Relay: lê `ORCHESTRATOR_PERMISSION_URL`/`ORCHESTRATOR_PERMISSION_TOKEN`; responde `initialize` (ecoa `protocolVersion`), `tools/list` (só `approve`), `tools/call` (POST `{ toolName, input, toolUseId }` com `node:http`, sem timeout; devolve `content[0].text = JSON.stringify(RelayDecision)`); qualquer outro método com `id` → `result: {}`; erro de rede ou status ≠ 200 → `deny` "O orquestrador não respondeu ao pedido de permissão; comando negado.".

- [ ] **Step 1: testes que falham**
  - `buildClaudeArgs` com `permissionChannel: null`: `--allowedTools` inclui `Bash` e `PowerShell`, `--permission-mode` = `YOLO_PERMISSION_MODE` (Task 2), sem `--mcp-config`/`--permission-prompt-tool`.
  - Com canal: `--allowedTools` **sem** `Bash`/`PowerShell`; `--permission-prompt-tool mcp__orchestrator__approve`; `--mcp-config` cujo JSON é `{ mcpServers: { orchestrator: { command, args, env: { ORCHESTRATOR_PERMISSION_URL: url, ORCHESTRATOR_PERMISSION_TOKEN: token } } } }`; `--strict-mcp-config` e `DISALLOWED_TOOLS` presentes nos dois modos.
  - Relay (spawn `node relay.mjs` com um `http.createServer` local de stub): `initialize` → ecoa `protocolVersion`; `tools/list` → uma ferramenta `approve`; `tools/call` → o stub recebe `X-Orchestrator-Token` e o corpo, e o relay devolve a decisão do stub; stub respondendo depois de 2 s ainda funciona; stub com `500` → `deny`; URL sem servidor → `deny`.
- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar; o `ClaudeCliRunner` passa `PERMISSION_ENV` (Task 2) no `spawn`. **Step 4:** PASS. **Step 5: Commit.**

### Task 6 (T109): PermissionBroker e rota interna

**Files:**
- Create: `apps/server/src/execution/permission-broker.ts`, `apps/server/src/http/routes/internal.ts`
- Modify: `apps/server/src/http/app.ts`, `apps/server/src/main.ts`
- Test: `apps/server/tests/unit/permission-broker.test.ts`, `apps/server/tests/integration/internal-permissions.test.ts`

**Interfaces:**
- Produces: `type PermissionHandler = (req: { toolName: string; input: Record<string, unknown>; toolUseId: string }) => Promise<RelayDecision>`; `class PermissionBroker { constructor(getBaseUrl: () => string); openChannel(handler: PermissionHandler): PermissionChannel; closeChannel(token: string): void; request(token: string, req): Promise<RelayDecision> }`. `url` = `${getBaseUrl()}/internal/permission-requests`. Token = `randomBytes(32).toString("hex")`.
- Rota `POST /internal/permission-requests` montada **fora** de `/api` e depois do origin guard; valida o corpo com Zod; responde `200 RelayDecision`; sem token ou token desconhecido → `403` com `deny`.

- [ ] **Step 1: testes que falham** — token desconhecido → `deny` sem chamar handler (Review Focus 5); `closeChannel` → `request` seguinte nega; um `request` pendente quando o canal fecha resolve `deny` "A invocação do agente terminou antes da decisão."; integração: POST com token válido segura a resposta até o handler resolver; sem cabeçalho → `403`; `Origin: http://evil.example` → `403 FORBIDDEN_ORIGIN`.
- [ ] **Step 2–4:** FAIL → implementar (broker instanciado em `main.ts` e passado ao executor e ao app) → PASS. **Step 5: Commit.**

### Task 7 (T110): Executor com pedidos de permissão

**Files:**
- Modify: `apps/server/src/execution/pipeline-executor.ts`, `apps/server/tests/fakes/fake-agent-runner.ts`
- Test: `apps/server/tests/unit/executor.test.ts` (grupo "US6")

**Interfaces:**
- Consumes: Tasks 3–6. `PipelineExecutorDeps.permissionBroker: PermissionBroker`; `StartRunInput.yolo: boolean`.
- Produces: `executor.decidePermission(runId: string, requestId: string, decision: PermissionDecision): Promise<void>` (`404` sem run/pedido; `409 INVALID_STATE` se o pedido não estiver `pending`).
- Fake: `FakeAgentRunner` aceita `broker?: PermissionBroker` no construtor; `FakeScript.permissionRequests?: Array<{ toolName: string; input: Record<string, unknown> }>` e `parallelPermissions?: boolean`; antes do atraso, chama `broker.request(invocation.permissionChannel.token, …)` (sequencial ou com `Promise.all`) e registra as decisões em `fake.permissionDecisions: RelayDecision[]`.

Fluxo do executor (por invocação, se `!run.yolo`): `openChannel(handler)` antes de `agentRunner.run`, `closeChannel` no `finally`. O handler: se algum `run.permissionRules` casa → registra `auto_allowed` e devolve `allow` na hora; senão cria o `PermissionRequest` `pending` (summary = `"<toolName>: <summarizeToolInput(input)>"`), aplica `permission_request`, pausa o timer, grava, emite e escreve a entrada `system` "Permissão pedida: <summary>"; espera a decisão. `decidePermission`: atualiza o pedido (`allow_always` acrescenta `deriveRule` a `run.permissionRules` sem duplicar e grava em `rule`), escreve "Permitido uma vez: …" / "Permitido sempre: <regra>" / "Negado: …", resolve o handler e, se não restar pendente, aplica `permission_decision` e retoma o timer. `deny` → `{ behavior: "deny", message: "Negado pelo usuário no orquestrador." }`. `interrupt`/`shutdown` em `awaiting_permission`: pendentes viram `cancelled`, o handler devolve `deny` "Execução interrompida.", e depois segue o caminho de interrupção da US3.

- [ ] **Step 1: testes que falham** (todos com `FakeAgentRunner` + broker real):
  - Yolo: `permissionChannel === null` na invocação e nenhum pedido criado.
  - Pedido → passo e run `awaiting_permission`, pedido `pending` com `summary` "Bash: npm test"; `allow_once` → fake recebe `allow` com `updatedInput` igual ao `input`, passo volta a `running` e conclui.
  - `allow_always` → `run.permissionRules` = `["Bash(npm test:*)"]`; um segundo pedido `npm test -- --run` na mesma execução vira `auto_allowed` sem pausar.
  - `deny` → fake recebe `deny` com "Negado pelo usuário no orquestrador.".
  - Dois pedidos em paralelo: decidir o primeiro mantém `awaiting_permission`; decidir o segundo volta a `running` (Review Focus 1).
  - Timer: `timeoutMinutes: 1`, 30 s trabalhando, pedido pendente por 10 min sem disparar, decisão, mais 29 s sem disparar, +1 s → `interrupted` com `timeout`.
  - `interrupt` com pedido pendente → fake recebe `deny`, pedido `cancelled`, passo `interrupted` com `interruptReason: "user"` (Review Focus 2).
  - `decidePermission` duas vezes no mesmo pedido → a segunda lança `409 INVALID_STATE`, e o fake recebeu uma única decisão.
  - O output do passo contém as entradas `system` "Permissão pedida: Bash: npm test" e "Permitido uma vez: Bash: npm test".
- [ ] **Step 2–4:** FAIL → implementar → PASS. **Step 5: Commit.**

### Task 8 (T111): Rotas REST

**Files:**
- Modify: `apps/server/src/http/routes/runs.ts`
- Test: `apps/server/tests/integration/runs-api.test.ts`

- [ ] **Step 1: testes que falham** — `POST /api/runs` com `yolo: true` grava `run.yolo === true` e, sem o campo, `false`; `POST /api/runs/:id/permissions/:requestId` com `{ decision: "allow_once" }` → `202` e o run volta a `running`; repetir → `409 INVALID_STATE` (Review Focus 4); `decision: "talvez"` → `400`; pedido inexistente → `404`; `POST /api/runs/:id/interrupt` aceito em `awaiting_permission`.
- [ ] **Step 2–4:** FAIL → implementar (`PermissionDecisionRequestSchema`; `interrupt` aceita `awaiting_permission`) → PASS. **Step 5: Commit.**

### Task 9 (T112): Interface

**Files:**
- Create: `apps/web/src/components/PermissionPrompt.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/components/FeatureInput.tsx`, `apps/web/src/pages/RunPage.tsx`, `apps/web/src/components/RunSummary.tsx`, `apps/web/src/format.ts`
- Test: `apps/web/tests/permissions.us6.test.tsx`

**Interfaces:**
- Produces: `decidePermission(runId: string, requestId: string, decision: PermissionDecision): Promise<void>`; `FeatureInput` ganha `yolo: boolean` e `onYoloChange(value: boolean)`; `<PermissionPrompt runId request />`.

- [ ] **Step 1: testes que falham** — checkbox com o texto exato aparece desmarcado; marcado mostra o aviso exato; enviar passa `yolo: true` ao `startRun`; recarregar a página (novo render) volta desmarcado. Com um pedido `pending` no run: mostra "Bash: npm test" e os botões "Permitir uma vez", "Permitir sempre `Bash(npm test:*)` nesta execução" e "Negar", cada um chamando `decidePermission` com a decisão certa; os botões ficam desabilitados enquanto a chamada está em andamento. O passo mostra "aguardando permissão". O `RunSummary` mostra "Modo Yolo" quando `run.yolo` e a lista de pedidos com a decisão.
- [ ] **Step 2–4:** FAIL → implementar (`STEP_STATUS_LABELS.awaiting_permission = "aguardando permissão"`, `RUN_STATUS_LABELS.awaiting_permission = "Aguardando permissão"`; o `runActive` da RunPage inclui `awaiting_permission`; o botão "Interromper" da US3 também aparece nesse estado) → PASS. **Step 5: Commit.**

### Task 10 (T113): Validação manual com a CLI real

**Files:** Modify: `specs/001-agent-pipeline-orchestrator/quickstart.md` (item 10), `specs/001-agent-pipeline-orchestrator/validation.md`

- [ ] **Step 1:** `npm run dev`, repositório de teste, Yolo desmarcado, esteira com um passo `/speckit-implement` interativo. Quando surgir um pedido de shell: "Permitir sempre"; confirmar que o mesmo prefixo não pergunta de novo; num pedido seguinte, "Negar" e confirmar no output que o agente recebeu a negação. Repetir com Yolo marcado e confirmar que nenhum pedido aparece. Confirmar `Get-Process claude` vazio depois de interromper com um pedido pendente.
- [ ] **Step 2:** registrar os resultados em `validation.md`. **Step 3: Commit.**
