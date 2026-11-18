# Contrato REST: `apps/server`

Base: `http://127.0.0.1:4317/api` · JSON em UTF-8 · só ouve em `127.0.0.1` (FR-026).
Requisições com `Origin`/`Host` fora da lista local permitida → `403` (research R7).
Os tipos referenciados estão em [data-model.md](../data-model.md) e são exportados por `@orchestrator/shared`.

## Formato de erro (todas as rotas)

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Texto compreensível", "issues": [{ "path": ["steps", 0, "command"], "message": "Obrigatório" }] } }
```

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_FAILED` | corpo inválido no schema Zod (`issues` presente) |
| 404 | `NOT_FOUND` | esteira ou execução inexistente |
| 409 | `RUN_ALREADY_ACTIVE` | já existe execução ativa (FR-012) |
| 409 | `INVALID_STATE` | ação incompatível com o estado atual (ex.: responder num passo que não está `awaiting_input`) |
| 409 | `BRANCH_CHANGED` | a branch em uso no envio difere de `expectedBranch` (FR-003a); `details.currentBranch` traz a branch atual |
| 422 | `REPO_REJECTED` | o repositório falhou nas validações de FR-002 ou a branch não pôde ser criada (`details.problems`) |
| 422 | `PIPELINE_INVALID` | o arquivo da esteira no disco não passa no `PipelineSchema` (`issues` presente) |
| 403 | `FORBIDDEN_ORIGIN` | origem não local |
| 500 | `INTERNAL_ERROR` | falha inesperada do servidor (a mensagem traz o erro original; detalhes no log) |

## Repositórios

| Método e rota | Corpo / query | Resposta |
|---|---|---|
| `GET /repos/inspect?path=<abs>` | — | `200 RepoInfo` (sempre 200; os problemas vão em `problems`) |
| `GET /settings` | — | `200 Settings` |

## Esteiras

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /pipelines` | — | `200 Pipeline[]` (padrão primeiro, depois por nome); arquivos inválidos são ignorados com aviso no log |
| `GET /pipelines/:id` | — | `200 Pipeline`; `422 PIPELINE_INVALID` se o arquivo for inválido |
| `POST /pipelines` | `PipelineInput` (sem `id`/datas) | `201 Pipeline` |
| `PUT /pipelines/:id` | `PipelineInput` | `200 Pipeline` |
| `POST /pipelines/:id/duplicate` | — | `201 Pipeline` (nome: "<nome> (cópia)", `isDefault: false`) |
| `DELETE /pipelines/:id` | — | `204`; `409 INVALID_STATE` se for a esteira padrão |

`PipelineInput` = `{ name, steps: StepInput[] }`. `StepInput` é igual a `Step`, com `id` opcional (gerado se ausente).

## Execuções

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /runs` | `{ repoPath, pipelineId, description, expectedBranch }` | `201 Run`. Revalida o repositório e compara a branch atual com `expectedBranch` (a exibida na tela; FR-003a) → `409 BRANCH_CHANGED` se diferir, sem criar branch nem ocupar a trava. Depois cria a branch e inicia o 1º passo de forma assíncrona. `422 PIPELINE_INVALID` se a esteira for inválida |
| `GET /runs` | — | `200 RunSummary[]`, mais recente primeiro (FR-016a) |
| `GET /runs/active` | — | `200 Run` ou `204` se não houver execução ativa |
| `GET /runs/:id` | — | `200 Run` |
| `GET /runs/:id/steps/:index/output?afterSeq=<n>` | — | `200 OutputEntry[]` (saída completa ou incremental; FR-015/FR-016) |
| `POST /runs/:id/reply` | `{ text }` (não vazio) | `202`; exige o passo atual em `awaiting_input` |
| `POST /runs/:id/advance` | — | `202`; exige o passo atual em `awaiting_input` |
| `POST /runs/:id/interrupt` | — | `202`; válido em `running`/`awaiting_input` |

`RunSummary` = `{ id, startedAt, repoPath, pipelineName, descriptionPreview (≤ 120 caracteres), status, finalBranch, totalDurationMs: number | null, totalUsage: Usage | null }`. Os totais vêm de `computeRunTotals` (data-model.md §4a) e não são persistidos.

As ações `reply`/`advance`/`interrupt` retornam `202` imediatamente. O resultado chega pelo WebSocket ([websocket-events.md](./websocket-events.md)).
