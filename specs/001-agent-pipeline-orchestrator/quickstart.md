# Quickstart: guia de validação

Roteiro para provar, de ponta a ponta, que a feature funciona. Contratos: [contracts/](./contracts/) · Modelo: [data-model.md](./data-model.md).

## Pré-requisitos

- Node.js ≥ 24 e npm ≥ 11 (`node --version`, `npm --version`)
- Git ≥ 2.40 (`git --version`)
- Claude Code instalado e logado com a assinatura. Verificação: `claude -p "responda apenas: ok" --output-format json` deve retornar `"is_error": false`.
- Um **repositório de teste** limpo, com o Spec Kit instalado (Spec Kit ≥ 1.4: a opção `--ai` virou `--integration`, e sem `--integration claude` uma execução não interativa instala o Copilot):

  ```powershell
  mkdir C:\temp\repo-teste; cd C:\temp\repo-teste
  git init
  specify init --here --integration claude --script ps --non-interactive --force
  git add -A; git commit -m "inicial"
  ```

  Confira que `.claude/skills/speckit-specify/SKILL.md` existe.

## Setup

```powershell
npm install
npm run typecheck      # tsc -b em todos os pacotes (strict)
npm test               # vitest em shared, server e web
npm run build          # build do web + server
npm start              # http://127.0.0.1:4317
```

Desenvolvimento: `npm run dev -w apps/server` e `npm run dev -w apps/web` (o Vite faz proxy de `/api` e `/ws`).

## Validações automatizadas (devem passar)

| Área | Comando | Prova |
|---|---|---|
| Schema da esteira | `npm test -w packages/shared` | definições válidas/inválidas e mensagens (FR-024) |
| Serviço de git | `npm test -w apps/server -- git` | FR-002, criação de branch, commits WIP, detecção de mudanças em refs (branch pré-existente, tags, refs remotas), em repositórios temporários |
| Máquina de estados | `npm test -w apps/server -- state-machine` | toda transição válida e rejeição das inválidas |
| Executor | `npm test -w apps/server -- executor` | sequência, passo interativo (responder/avançar), falha, interrupção, timeout que só conta o trabalho do agente, execução única, com `FakeAgentRunner` |
| Encerramento de árvore | `npm test -w apps/server -- kill-tree` | árvore de processos encerrada em < 5 s (SC-005) |
| Escuta local | `npm test -w apps/server -- server` | `address()` = `127.0.0.1`; `Origin` estranho → 403 |
| UI | `npm test -w apps/web` | caixas por status, botão de enviar bloqueado com descrição vazia, histórico somente leitura |

## Validações manuais (cenários da spec)

1. **US1 ponta a ponta (SC-001, SC-006)**: abra `http://127.0.0.1:4317`, cole o caminho do repositório de teste e confirme que a branch atual aparece. Descreva "Adicionar um endpoint /health que retorna ok" e envie. Responda uma vez no Clarify e depois clique em avançar. No Implement, revise a saída e clique em avançar (ou responda, se ele perguntar sobre checklists incompletos). No Specify, a saída não deve terminar com perguntas ao usuário; dúvidas aparecem como `[NEEDS CLARIFICATION]` na spec gerada.
   **Esperado**: os cinco passos ficam "concluído". `git log --all --oneline` mostra commits só em `orchestrator/...` (com o Spec Kit 1.4.1 sem a extensão de git, o Specify não cria branch; com ela, também na branch criada pelo Specify). A spec fica em `specs/<NNN>-<slug>/spec.md` e `.specify/feature.json` aponta para essa pasta. Na saída do Specify, a linha de sistema inicial informa o modelo do passo. No Clarify, depois de cada resposta, o consumo do passo cresce só com o custo da nova invocação; o custo da sessão anterior não é somado de novo. `git rev-parse <branch de origem>` é igual ao valor anterior ao envio, e a tela informa a branch final.
2. **US2 tempo real (SC-003/SC-004)**: durante o Plan, abra a saída do passo. O texto deve aparecer incrementalmente, sem esperar o fim do passo.
3. **US3 interromper (SC-005)**: inicie uma nova execução e clique em interromper durante o Plan.
   **Esperado**: em ≤ 5 s o passo fica "interrompido" e não restam processos `claude` (`Get-Process claude` vazio). Se havia alterações, existe um commit "WIP: passo Plan interrompido", e `git status` mostra a árvore limpa.
4. **Timeout**: crie uma esteira com um passo `/speckit-specify`, `timeoutMinutes: 1`, e rode.
   **Esperado**: "interrompido" com motivo "tempo limite excedido".
5. **Recusas (FR-002)**: deixe um arquivo modificado no repositório de teste e tente enviar. A execução deve ser recusada com o motivo. Repita com uma pasta que não é repositório Git.
6. **US4 editor (SC-007)**: crie a esteira "Mini" com Specify e Plan, salve, reinicie o servidor e verifique que ela continua listada e executa.
7. **US5 histórico (SC-008)**: depois dos itens acima, reinicie o servidor e abra o histórico. As execuções aparecem da mais recente para a mais antiga, e a saída de cada passo é consultável, sem botões de editar ou reexecutar.
8. **Encerramento do servidor**: com um passo rodando, pressione Ctrl+C no terminal do servidor e suba de novo. A execução deve aparecer como "interrompida" no histórico.
9. **Pasta de dados**: confirme que nada foi criado no repositório alvo além do trabalho dos passos. Os dados ficam em `%APPDATA%\agent-orchestrator`.
10. **US6 permissões e Modo Yolo (SC-009)**: com o Modo Yolo **desmarcado**, rode uma esteira com um passo `/speckit-implement` interativo. Quando surgir um pedido de comando de shell, clique em "Permitir sempre `<regra>` nesta execução" e confirme que o mesmo prefixo não pergunta de novo. Num pedido seguinte, clique em "Negar" e confirme na saída do passo que o agente recebeu a negação e que o comando não rodou. Com um pedido pendente, clique em interromper.
    **Esperado**: em ≤ 5 s o passo fica "interrompido", o pedido aparece como cancelado e `Get-Process claude` fica vazio. Repita com o Modo Yolo **marcado**: nenhum pedido aparece, e o resumo da execução indica "Modo Yolo". Os pedidos e as decisões aparecem no histórico.
