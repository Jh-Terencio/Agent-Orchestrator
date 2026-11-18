# Design: modo Yolo e pedidos de permissão em tempo real

**Data**: 2026-11-17 · **Feature base**: `specs/001-agent-pipeline-orchestrator` · **Status**: aguardando aprovação

## Intenção

Hoje o agente roda com `Bash`/`PowerShell` liberados sem restrição (research R3): pode executar qualquer
comando na máquina do usuário, sem ninguém olhando. O usuário quer controle:

- **Por padrão**, o agente pede permissão antes de rodar comandos, e o usuário decide na hora,
  pela interface, se libera ou não.
- **Modo Yolo**, escolhido conscientemente por um checkbox desligado por padrão: o agente faz o que
  precisar sem perguntar.

## Objetivos, não objetivos e antiobjetivos

**Objetivos**

- Checkbox "Modo Yolo" na tela de envio, desligado por padrão, gravado na execução.
- Com Yolo desligado, cada comando de shell que a CLI não aprova sozinha vira um **pedido de
  permissão** visível na interface, com o processo do agente parado esperando.
- Três decisões por pedido: **Permitir uma vez**, **Permitir sempre nesta execução** e **Negar**.
- Pedidos e decisões registrados no histórico da execução (Princípio VI).

**Não objetivos (v1)**

- Regras de permissão que persistem entre execuções ou por esteira, e editor de regras.
- Sandbox de sistema de arquivos/rede ou container.
- Pedir permissão para editar arquivos (continua `acceptEdits`, research R3).
- Notificação do sistema operacional quando surge um pedido.

**Antiobjetivos** (seria fracasso mesmo funcionando)

- O agente conseguir aprovar os próprios pedidos.
- Falha no canal de permissão resultar em comando executado (o canal falha **fechado**: nega).
- Yolo desligar a proteção do git: os bloqueios de `git push/commit/reset/...` e a verificação de refs
  de FR-011a valem nos dois modos (Princípio II, inegociável).
- O tempo que o usuário leva para decidir contar para o limite do passo (FR-018a).

## Abordagens consideradas

| | Abordagem | Troca | Decisão |
|---|---|---|---|
| A | **Pausa depois da invocação**: comandos fora da lista são negados na hora; ao fim, o orquestrador lê `permission_denials` do `result`, pausa o passo e, se o usuário permitir, retoma a sessão com a ferramenta liberada | Simples e só usa recursos documentados; mas a decisão vem depois do fato, o agente pode já ter contornado, e liberar custa uma nova invocação | Rejeitada |
| **B** | **Pergunta em tempo real** via `--permission-prompt-tool`: a CLI consulta um servidor MCP do orquestrador antes de cada uso não aprovado e espera a resposta; o agente continua de onde parou | Fiel à intenção; exige um canal MCP próprio, pausar o timer enquanto se decide e depende de uma parte pouco documentada da CLI | **Escolhida pelo usuário** |
| C | **Liberação prévia por passo** no editor da esteira | Não avisa quando surge um pedido novo, que é o que o usuário quer | Descartada |

## Validação feita (spike descartável, CLI 2.1.327, `haiku`)

Com `--strict-mcp-config --mcp-config <servidor stdio mínimo> --permission-prompt-tool mcp__perm__approve`,
`--permission-mode acceptEdits`, `--setting-sources project,local` e `Bash` **fora** de `--allowedTools`:

- comando que escreve arquivo (`node -e "...writeFileSync..."`) → a CLI chamou a ferramenta com
  `{ tool_name: "Bash", input: { command, description }, tool_use_id }` **antes** de executar;
- resposta `{"behavior":"allow","updatedInput":<input>}` → executou;
  `{"behavior":"deny","message":"..."}` → não executou, o agente recebeu a mensagem como `tool_result`
  com erro e o `result` listou o item em `permission_denials`;
- o servidor apareceu em `mcp_servers` como `connected`, e a ferramenta **não** apareceu na lista de
  ferramentas do agente (ele não consegue chamá-la);
- **comandos considerados somente leitura (ex.: `echo`) foram aprovados pela própria CLI, sem consulta.**
  Isso não é controlável pelo orquestrador e vale para o modo padrão;
- protocolo observado no servidor: `server/discover`, `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call` (JSON-RPC, uma mensagem por linha).

**Não verificado**: por quanto tempo a CLI espera a resposta de `tools/call` (o usuário pode levar
minutos). É a primeira tarefa do plano; se houver limite, ajustar por variável de ambiente no `spawn`
(ex.: `MCP_TOOL_TIMEOUT`) ou, sem saída, registrar o limite e tratar como "negado por tempo".

## Comportamento

### Modo de permissão da execução

- `StartRunRequest` ganha `yolo: boolean` (padrão `false`); `Run` ganha `yolo: boolean`
  (`.default(false)` no schema, para `run.json` antigos continuarem válidos).
- **Yolo ligado**: argumentos de hoje (`acceptEdits`, `--allowedTools` com `Bash`/`PowerShell`,
  `--disallowedTools` com os comandos git) e **sem** canal de permissão. *Chamada do construtor:*
  verificar se `--permission-mode bypassPermissions` respeita `--disallowedTools`; se respeitar, usar
  `bypassPermissions` (libera também ferramentas fora da lista, como `WebFetch`); se não, manter os
  argumentos de hoje.
- **Yolo desligado** (padrão): `--allowedTools` sem `Bash`/`PowerShell`, mesmos `--disallowedTools`,
  mais `--mcp-config <servidor de permissão> --permission-prompt-tool mcp__orchestrator__approve`
  (com `--strict-mcp-config`, que já usamos). Tudo que a CLI não aprova sozinha passa pelo canal.

### Canal de permissão

```text
claude ──stdio MCP──► permission-relay (processo filho do claude)
                         │ POST http://127.0.0.1:<porta>/internal/permission-requests
                         │ cabeçalho X-Orchestrator-Token: <token aleatório da invocação>
                         ▼
                      servidor do orquestrador ── segura a requisição até a decisão ──► resposta
```

- **Relay stdio** (decisão do design): script pequeno do próprio servidor, JSON-RPC à mão como no spike,
  **sem** dependência nova (Princípio III). Ele não decide nada: repassa `tools/call` ao orquestrador e
  devolve a decisão. Precisa rodar com `node` puro em desenvolvimento e em produção (`npm start`).
- **Token por invocação**: gerado pelo executor, passado ao relay por variável de ambiente na
  `--mcp-config`, válido só enquanto a invocação está viva. Requisição sem token válido → `403`. A rota
  `/internal/...` fica fora de `/api` e continua sob o *origin guard* e o `listen` em `127.0.0.1`.
- **Falha fechada**: relay sem resposta, erro de rede, token inválido, execução interrompida ou
  servidor encerrando → `deny` com mensagem explicando o motivo.

### Pedido de permissão

`PermissionRequest` (novo, embutido em `StepRun.permissionRequests[]`):

| Campo | Notas |
|---|---|
| `id` | uuid gerado pelo orquestrador |
| `toolUseId` | id da CLI |
| `toolName` | ex.: `Bash` |
| `input` | entrada bruta da ferramenta (comando, descrição) |
| `summary` | texto exibido, no formato do `tool_use` do parser (ex.: `Bash: npm test`) |
| `status` | `pending` · `allowed_once` · `allowed_always` · `denied` · `auto_allowed` (casou com regra) · `cancelled` (interrupção/encerramento) |
| `rule` | regra criada por "permitir sempre", quando houver |
| `requestedAt` / `decidedAt` | ISO |

- `Run.permissionRules: string[]` guarda as regras de "permitir sempre nesta execução".
- **Regra derivada** (decisão do design): para `Bash`/`PowerShell`, o prefixo com os dois primeiros
  tokens do comando, no formato do Claude Code (`Bash(npm test:*)`); para comandos de um token, só ele
  (`Bash(make:*)`); para outras ferramentas, o nome da ferramenta. O botão mostra a regra antes de o
  usuário clicar ("Permitir sempre `npm test …` nesta execução").
- Pedido que casa com uma regra é respondido `allow` na hora, sem pausar, e registrado como
  `auto_allowed`.
- **Vários pedidos ao mesmo tempo** (chamadas de ferramenta em paralelo) ficam numa fila; cada um é
  decidido individualmente.
- Cada pedido e cada decisão geram uma `OutputEntry` `system` no passo
  (ex.: "Permissão pedida: Bash: npm test" / "Permitido sempre: Bash(npm test:*)").

### Estados e limite de tempo

- Novo `StepStatus` e `RunStatus` **`awaiting_permission`**:
  `running ─permission_request→ awaiting_permission ─permission_decision→ running`
  (ou continua `awaiting_permission` enquanto houver pedidos pendentes).
- `awaiting_permission` aceita `interrupt`/`timeout`?/`shutdown`: **interrupt** e **shutdown** encerram
  como em `running` (há processo vivo; pendentes viram `cancelled`, a CLI recebe `deny`); **timeout não
  ocorre**, porque o timer está pausado.
- **Timer pausável**: ao entrar em `awaiting_permission`, o executor guarda o tempo restante e cancela o
  `setTimeout`; ao voltar a `running`, agenda de novo com o restante (FR-018a, research R4; segue
  controlável por *fake timers*).
- Sem decisão, o passo fica em `awaiting_permission` indefinidamente, como em "aguardando resposta"
  (*chamada do design*), limitado só pelo que a CLI suportar de espera (ver "Não verificado").
- A máquina de estados ganha os eventos `permission_request` e `permission_decision`, com testes de
  cada transição nova e das inválidas (Princípio VII).

### API e eventos

- `POST /api/runs` aceita `yolo`.
- `POST /api/runs/:id/permissions/:requestId` com `{ decision: "allow_once" | "allow_always" | "deny" }`
  → `202`; `409 INVALID_STATE` se o pedido não estiver `pending`; `404` se não existir.
- `POST /internal/permission-requests` (só o relay usa): segura a resposta até a decisão.
- Sem evento WebSocket novo: `run.updated` já leva o `StepRun` com os pedidos.

### Interface

- Ao lado do "Enviar": checkbox **"Modo Yolo: o agente executa qualquer comando sem perguntar"**,
  desmarcado ao carregar a página (não é lembrado entre envios). Marcado, mostra um aviso curto do
  risco.
- Com um pedido pendente: painel destacado no passo, com o comando completo e os três botões. A caixa do
  passo mostra "aguardando permissão".
- Resumo e histórico mostram se a execução rodou em Yolo e listam os pedidos com a decisão.

```text
[ Descrição da feature .............................................. ]
[ ] Modo Yolo: o agente executa qualquer comando sem perguntar    [Enviar]

┌ Plan · aguardando permissão ──────────────────────────────────────────┐
│ O agente quer executar:                                               │
│   Bash: npm test -- --run                                             │
│ [Permitir uma vez] [Permitir sempre `npm test …` nesta execução] [Negar] │
└───────────────────────────────────────────────────────────────────────┘
```

## Restrições

- Constituição: Princípio II (git protegido nos dois modos), III (sem dependência nova; relay à mão),
  VI (pedidos e decisões visíveis e no histórico), VII (testes de toda a lógica nova, com fakes; os
  testes nunca chamam o `claude` real).
- Execução 100% local; a rota interna só aceita o token da invocação viva.
- `FakeAgentRunner` ganha um roteiro que dispara pedidos de permissão, para testar executor e API sem a
  CLI real; o relay tem teste próprio de protocolo (stdin/stdout).

## Onde entra no plano

Depende da US3 (encerramento da árvore de processos, `interrupt`, timer por invocação), então entra
como **nova história (US6, P2) depois da Fase 5**. Ao aprovar este design, o plano inclui atualizar os
artefatos do Spec Kit (spec: história e FRs novos; research: R13 com o spike; data-model;
contracts REST/agent-runner; tasks.md com a fase nova), para que eles continuem sendo a fonte da verdade.

## Deixado para o construtor

- `bypassPermissions` × argumentos de hoje no Yolo (critério acima).
- Tempo de espera da CLI em `tools/call` e o ajuste necessário.
- Forma de empacotar o relay para rodar com `node` puro em dev e produção.
- Texto exato das mensagens e dos avisos na interface.
