# Phase 0 — Research: Orquestrador Visual de Esteira de Agentes

**Feature**: `001-agent-pipeline-orchestrator` | **Data**: 2026-11-17

Cada item segue o formato **Decisão / Racional / Alternativas consideradas**. Todos os itens
"NEEDS CLARIFICATION" do Technical Context estão resolvidos aqui.

---

## R1. Integração com o agente: Claude Agent SDK × CLI `claude -p`

**Decisão**: usar a **CLI do Claude Code em modo não interativo** (`claude -p ... --output-format stream-json --verbose --include-partial-messages`), iniciada pelo servidor como processo filho (`child_process.spawn`), atrás da interface `AgentRunner` (ver [contracts/agent-runner.md](./contracts/agent-runner.md)).

**Racional**:

- **Critério decisivo (login da assinatura)**: a documentação de autenticação do Claude Code lista o OAuth da assinatura (`/login`) como credencial padrão para usuários Pro/Max, e o `claude -p` usa as mesmas credenciais da CLI interativa. Já a página de *Legal and compliance* diz que desenvolvedores construindo produtos ou serviços com o Agent SDK devem usar chave de API do Console, e que os tokens OAuth da assinatura são destinados ao uso do Claude Code e dos apps nativos da Anthropic. Usar a CLI oficial é o caminho que está claramente dentro do uso pessoal do Claude Code. O SDK estaria numa área cinzenta.
- **Requisitos atendidos pela CLI** (verificados na versão 2.1.326 instalada):
  | Necessidade | Mecanismo |
  |---|---|
  | Streaming da saída | `--output-format stream-json --verbose` (um JSON por linha) + `--include-partial-messages` (deltas de texto, para SC-003 ≤ 2 s) |
  | Modelo por passo | `--model <alias ou id>` |
  | Retomada de sessão (passo interativo) | 1ª chamada com `--session-id <uuid>` gerado pelo orquestrador; cada resposta com `--resume <uuid> -p "<resposta>"` |
  | Cancelamento | encerrar a árvore de processos (ver R5) |
  | Consumo | o evento final `{"type":"result"}` traz `usage` (tokens de entrada/saída/cache), `total_cost_usd`, `duration_ms`, `num_turns`, `is_error`, `session_id` |
- O SDK TypeScript também roda a CLI por baixo. Trocar depois exige só uma nova implementação de `AgentRunner`.

**Alternativas consideradas**:

- *Claude Agent SDK (TypeScript)*: API mais rica (objetos tipados, `AbortController`, callbacks de permissão). Foi rejeitado por causa do critério decisivo: os termos indicam chave de API para produtos feitos com o SDK.
- *API de Mensagens direta*: exige chave de API e reimplementar ferramentas e skills. Descartada.

**Riscos registrados**: a cobrança e o pool de uso do `claude -p` mudaram ao longo de 2026, e as fontes divergem sobre se o uso sai dos limites da assinatura ou de um crédito mensal separado. Isso não muda a escolha técnica. O consumo reportado no evento `result` é exibido ao usuário (Princípio VIII). A `quickstart.md` inclui uma verificação manual da autenticação (`claude -p "ping"`).

---

## R2. Carregamento dos comandos do Spec Kit

**Decisão**: o campo `command` do passo é enviado como início do prompt (`/speckit-specify <descrição>`). O processo do agente roda com `cwd` = repositório alvo, então o Claude Code carrega os comandos e skills do projeto (`.claude/skills/<nome>/SKILL.md` ou `.claude/commands/<nome>.md`) e a configuração do projeto. Só o primeiro passo recebe a descrição da feature (FR-006). Os demais recebem só o comando, e o contexto vem dos artefatos no repositório (premissa da spec).

**Detalhes**:

- Versões recentes do Spec Kit instalam **skills** com hífen (`speckit-specify`, como neste repositório). Versões antigas instalam **comandos** com ponto (`speckit.specify`). A esteira padrão usa a forma com hífen (`/speckit-specify`, `/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`). O usuário edita a esteira se o alvo usar a forma com ponto.
- **Pré-verificação (edge case "skill inexistente")**: antes de iniciar o passo, o executor verifica se o comando existe em `<repo>/.claude/skills/<nome>/SKILL.md`, `<repo>/.claude/commands/<nome>.md` ou nos equivalentes em `~/.claude/`. Se o comando não existir, o passo falha com mensagem clara, sem gastar uso do modelo. Prompts que não começam com `/` não são verificados.

**Alternativas consideradas**: ler o `SKILL.md` e injetar seu conteúdo no prompt. Rejeitada porque duplica o mecanismo nativo e quebra os scripts relativos da skill.

### R2a. Passos não interativos não podem parar para perguntar (FR-006a)

**Problema**: em `-p`, quando o agente termina o turno com uma pergunta, a CLI emite `result` sem erro. O Specify pode parar esperando respostas a `[NEEDS CLARIFICATION]`, e o Implement pode parar perguntando se deve seguir com checklists incompletos. Nos dois casos o passo seria marcado como "concluído" sem ter terminado o trabalho (falso sucesso).

**Decisão**:

- Em passos **não interativos**, o `ClaudeCliRunner` adiciona `--append-system-prompt` com um texto fixo (constante `NON_INTERACTIVE_SYSTEM_PROMPT` em `agent/system-prompts.ts`). Conteúdo: "Você está rodando sem usuário presente, numa esteira automatizada. Não faça perguntas nem aguarde confirmação. Quando houver dúvida, escolha a opção mais razoável, registre a dúvida nos artefatos (ex.: marcador [NEEDS CLARIFICATION]) e conclua o trabalho do comando." Esse texto é adicionado e não substitui o system prompt padrão do Claude Code, que continua com as ferramentas e as skills.
- Em passos **interativos** o texto não é adicionado, porque perguntar é o comportamento esperado e a esteira pausa em "aguardando resposta".
- Na esteira padrão, o **Implement passa a ser interativo** (FR-020). Assim, a confirmação de checklists incompletos do `/speckit-implement` funciona pelo fluxo responder/avançar, e o usuário tem um ponto de revisão antes do commit final (que só acontece ao avançar, FR-009a). O limite de 120 minutos vale para cada invocação (R4).
- Teste unitário: verifica que os argumentos gerados incluem `--append-system-prompt` se e somente se `interactive === false`.

**Alternativas consideradas**: detectar perguntas na saída por heurística (frágil, com falsos positivos); tornar todos os passos interativos (exigiria intervenção em todo passo e contraria SC-001).

---

## R3. Permissões do agente em modo não interativo

**Decisão**: cada chamada usa:

```text
--permission-mode acceptEdits
--allowedTools Read Edit Write Glob Grep Skill TodoWrite Bash PowerShell
--disallowedTools "Bash(git push:*)" "Bash(git merge:*)" "Bash(git rebase:*)" "Bash(git reset:*)"
                  "Bash(git commit:*)" "Bash(git cherry-pick:*)" "Bash(git revert:*)" "Bash(git tag:*)"
                  "Bash(git branch -D:*)" "Bash(git branch -d:*)" "Bash(git update-ref:*)"
                  (+ as mesmas regras com o prefixo PowerShell(...))
```

- Editar arquivos e rodar comandos são permitidos, porque os scripts do Spec Kit (`.specify/scripts/...`) precisam disso, inclusive `git checkout -b` / `git switch -c` do Specify.
- Regras de *deny* têm precedência sobre *allow* no Claude Code. Em `-p`, ferramentas não pré-aprovadas são negadas automaticamente, sem prompt.
- O agente não faz commits. Commits e validação de branch são do orquestrador (spec FR-010/FR-011a).
- A lista de regras fica numa constante única (`agent/permissions.ts`) coberta por teste unitário que confere os argumentos gerados.

**Defesa em profundidade (garantia real do Princípio II)**: os padrões de *deny* casam por prefixo de comando e podem ser contornados (ex.: `cd x && git push`, `git -C . reset`). Por isso o `GitService` registra, no início da execução, um **snapshot de refs** (`refs/heads`, `refs/remotes` e `refs/tags`, cada ref com seu SHA) e, ao fim de cada passo, verifica (FR-011a):

1. a branch ativa não é uma branch pré-existente;
2. nenhuma ref pré-existente de `refs/heads` mudou de SHA nem foi removida (refs **novas** em `refs/heads` são permitidas: são as branches criadas pela execução);
3. em `refs/remotes` e `refs/tags`, **nenhuma** ref foi criada, removida ou alterada. Uma mudança ali indica push (que atualiza as refs de rastreamento), fetch ou tag feitos pelo agente.

Se qualquer verificação falhar, o passo fica "com erro" com uma mensagem que lista as refs afetadas, nada é commitado e a esteira para. O orquestrador nunca faz push nem fetch, e seus próprios commits só movem branches criadas pela execução, por isso não disparam a verificação.

**Risco conhecido**: versões antigas do script `create-new-feature` do Spec Kit rodavam `git fetch --all --prune` para numerar features, o que faria o Specify falhar nessa verificação. A versão instalada neste repositório não faz fetch. Se o repositório alvo usar uma versão antiga, a mensagem de erro aponta a ref remota alterada, e a correção é atualizar o Spec Kit no alvo.

**Alternativas consideradas**: `bypassPermissions` + *deny* (permissivo demais); hook `PreToolUse` customizado no repositório alvo (escreveria arquivos no alvo, o que é proibido pelo requisito de não sujar a árvore de trabalho); sandbox de SO (complexo demais para v1).

---

## R4. Limite de tempo (FR-018a)

**Decisão**: o timer é por **invocação do agente**, não por passo. Para cada chamada de `AgentRunner.run()` (execução inicial e cada resposta), o executor cria um `AbortController` e agenda `setTimeout(() => controller.abort("timeout"), timeoutMinutes × 60 000)`, com `timeoutMinutes` do passo (padrão 30, Implement 120). O mesmo controller é abortado com `"user"` ou `"server_shutdown"` no interromper ou no encerramento do servidor, e `signal.reason` define o `interruptReason`. O `clearTimeout` acontece quando a invocação termina. Não usar `AbortSignal.timeout`: ele usa um timer interno que os *fake timers* do Vitest (`vi.useFakeTimers()` / `vi.advanceTimersByTime`) não controlam, e `setTimeout` permite testar o limite sem esperar tempo real. A pausa em "aguardando resposta" não tem processo vivo e por isso não conta. Quando o limite estoura, o passo é encerrado pelo mesmo caminho do "interromper" (R5), com `interruptReason = "timeout"`.

**Alternativas**: `--max-turns` (limita turnos, não tempo); timer global do passo (contaria a pausa e violaria a spec).

---

## R5. Encerrar o agente e todos os subprocessos em ≤ 5 s (SC-005)

**Decisão**: utilitário próprio `killProcessTree(pid)` em `apps/server/src/agent/kill-tree.ts`:

- **Windows**: `taskkill /PID <pid> /T /F` (encerra a árvore inteira e é imediato).
- **POSIX**: o processo é iniciado com `detached: true` (vira líder de grupo). Primeiro `process.kill(-pid, 'SIGTERM')`. Se o processo não sair em 2 s, `process.kill(-pid, 'SIGKILL')`.
- O `AgentRunner` resolve a execução como `interrupted` assim que o processo sai, ou depois de 4 s (garantia), para que o executor sempre avance dentro dos 5 s.
- Teste de integração: cria uma árvore de processos falsa (node → node filho que dorme) e verifica que ambos somem em < 5 s.

**Alternativas**: pacote `tree-kill` (dependência a mais para cerca de 20 linhas, rejeitado pelo Princípio III); `child.kill()` (não encerra netos no Windows).

---

## R6. Repositório Git: como operar

**Decisão**: `GitService` chama o binário `git` via `execFile` (sem shell), com `cwd` = repositório alvo. Operações:

| Operação | Comando |
|---|---|
| É repo válido? | `git rev-parse --is-inside-work-tree` + `git rev-parse --show-toplevel` |
| Alterações pendentes? | `git status --porcelain=v1 --untracked-files=all` |
| Merge/rebase em andamento? | existência de `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD` em `git rev-parse --git-dir` |
| Branch atual | `git symbolic-ref --short -q HEAD` (vazio = HEAD destacado → recusa) |
| Snapshot de refs | `git for-each-ref --format=%(refname) %(objectname) refs/heads refs/remotes refs/tags` (nome completo, para distinguir os grupos) |
| Criar branch inicial | `git switch -c <nome>` (falha se já existir) |
| Commit | `git add -A` e depois `git commit -m <msg>` (pula o commit se o porcelain estiver vazio) |

- **Nome da branch inicial**: `orchestrator/<AAAAMMDD-HHmmss>-<slug-da-descrição≤40>`. O nome é único por timestamp e verificado antes da criação.
- **Mensagens de commit**: `orchestrator: <passo> concluído` / `WIP: passo <passo> interrompido` / `WIP: passo <passo> com erro`, com trailer `Orchestrator-Run: <runId>`.
- **Testes de integração**: repositórios temporários criados com `fs.mkdtemp` + `git init`, com `user.name`/`user.email` configurados localmente no teste.

**Alternativas**: `simple-git` (dependência extra para um conjunto pequeno de comandos); `isomorphic-git` (comportamento diferente do git real).

---

## R7. Servidor HTTP e WebSocket

**Decisão**: **Express 5** para REST e **ws** para WebSocket, no mesmo `http.Server`, com `listen(PORT, '127.0.0.1')` (FR-026). Porta padrão `4317`, configurável por `ORCHESTRATOR_PORT`. Em produção (`npm start`), o servidor também serve o build estático de `apps/web/dist`.

- **Proteção local extra**: o servidor rejeita requisições e *upgrades* de WebSocket cujo cabeçalho `Origin` não seja `http://127.0.0.1:<porta>`/`http://localhost:<porta>` (ou a porta do Vite em desenvolvimento). Isso evita que outra aba do navegador dispare execuções (DNS rebinding/CSRF). O cabeçalho `Host` também é validado.
- **Justificativa das dependências** (Princípio III): `express` para roteamento e parsing de JSON (evita reescrever um mini-framework); `ws` porque o Node não oferece servidor WebSocket nativo.

**Alternativas**: Fastify (equivalente, mas menos familiar); Server-Sent Events (cobriria o envio de eventos do servidor, mas o usuário pediu WebSocket explicitamente); `http` puro (mais código a manter).

---

## R8. Persistência em arquivos JSON

**Decisão**: pasta de dados do orquestrador, **fora do repositório alvo**:

- Padrão: `%APPDATA%\agent-orchestrator` no Windows e `~/.local/share/agent-orchestrator` nos demais. Pode ser sobrescrita por `ORCHESTRATOR_DATA_DIR` (usado nos testes).
- Estrutura: `pipelines/<id>.json`, `runs/<runId>/run.json` (registro da execução) e `runs/<runId>/<stepIndex>.output.jsonl` (saída do passo, uma entrada por linha, gravada em modo *append*).
- Escrita atômica de `run.json` e das esteiras: grava em `*.tmp` e faz `rename`.
- **Primeira inicialização**: se `pipelines/` estiver vazia, grava a esteira padrão do Spec Kit (FR-020) com `isDefault: true`.
- **Recuperação após falha**: na inicialização, qualquer `run.json` com status não terminal (`running`/`awaiting_input`) é marcado como `interrupted`, com motivo `server_shutdown` (cobre o caso em que o processo morreu sem passar pelo *shutdown* gracioso).

**Alternativas**: SQLite (vetado pelo usuário: sem banco); um único arquivo de histórico (cresce sem limite e tem risco de corrupção).

---

## R9. Schema compartilhado

**Decisão**: **Zod** em `packages/shared`. Os tipos TypeScript são derivados com `z.infer`. Zod é usado no servidor (validação ao salvar/executar e ao ler arquivos do disco) e no front-end (validação do editor com mensagens por campo). O schema também define as mensagens do WebSocket e os DTOs REST.

**Alternativas**: JSON Schema + Ajv (exige gerar tipos separadamente); TypeBox (menos ergonômico para mensagens de erro na UI).

---

## R10. Saída do passo exibida ao usuário

**Decisão**: o `ClaudeCliRunner` converte as linhas `stream-json` em `OutputEntry` normalizadas: `text` (deltas de texto do assistente, agregados), `tool_use` (nome da ferramenta + resumo da entrada, ex.: o comando Bash), `tool_result` (truncado em 4 KB na exibição, com o conteúdo completo no arquivo), `user_reply` (respostas do usuário em passos interativos), `system` e `error`. As entradas são gravadas em `.output.jsonl` e enviadas via WebSocket em lotes a cada ≤ 250 ms, o que atende SC-003.

---

## R11. Seleção do repositório no navegador

**Decisão**: o navegador não expõe caminhos absolutos de pastas. A tela tem um campo de texto para colar o caminho e uma lista dos **repositórios recentes** (gravada em `settings.json` na pasta de dados). Ao confirmar, a UI chama `GET /api/repos/inspect?path=...`, que retorna validade, branch atual e motivo de recusa (FR-001, FR-002, FR-003a).

**Alternativas**: navegador de diretórios no servidor (mais UI e mais superfície de API, fica para depois); Electron (fora da stack escolhida).

---

## R12. Ferramentas de desenvolvimento

**Decisão**: Node 24 LTS (instalado: 24.15.0), npm workspaces, TypeScript 5.x (`strict`, `noUncheckedIndexedAccess`), Vitest (`environment: node` no servidor e `jsdom` + Testing Library no web), `tsx` para rodar o servidor em desenvolvimento, Vite + `@vitejs/plugin-react`. O Vite em desenvolvimento faz proxy de `/api` e `/ws` para `127.0.0.1:4317`.

- O pacote `shared` é consumido como fonte TypeScript, via `exports` apontando para `src/index.ts` e *project references*. Isso evita uma etapa de build separada.
