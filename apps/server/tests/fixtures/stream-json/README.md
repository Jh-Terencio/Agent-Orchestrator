# Fixtures `stream-json` do Claude Code

Saídas reais de `claude -p ... --output-format stream-json --verbose --include-partial-messages`, usadas
pelos testes do `stream-json-parser` (T044). Os testes **nunca** chamam o `claude` real.

| Arquivo | Conteúdo |
|---|---|
| `success.jsonl` | 1ª invocação (`--session-id`): `system` init, deltas de ferramenta (`input_json_delta`), `tool_use` (Read), `rate_limit_event`, `tool_result`, deltas de texto (`text_delta`) e `result` com `usage`, `total_cost_usd` e `model_usage_since_last_result` |
| `resume.jsonl` | 2ª invocação da **mesma sessão** (`--resume`). `total_cost_usd` é o **acumulado** da sessão; `usage` e `model_usage_since_last_result` são só desta invocação |
| `question-ending.jsonl` | Passo interativo que termina com uma pergunta (`result` sem erro) |
| `error-result.jsonl` | `result` com `is_error: true` (modelo inexistente) |
| `auth-error.jsonl` | `result` com `is_error: true` emitido quando a CLI não está logada (`Not logged in · Please run /login`) |

Captura feita em 2026-11-17 com Claude Code 2.1.327, modelo `haiku`, num repositório temporário com um
`README.md`, usando os argumentos de `buildClaudeArgs` (inclui `--setting-sources project,local
--strict-mcp-config`). Valores de referência: `success` custou US$ 0,00463959; o `resume` reportou
`model_usage_since_last_result.costUSD` = 0,00023752 e `total_cost_usd` = 0,00487711 (= soma das duas).

## Como recapturar

A captura é manual e consome a assinatura (com `haiku` e prompts curtos, frações de centavo).

1. Na raiz do repositório, com o `claude` logado:
   `npx tsx apps/server/tests/fixtures/stream-json/tools/capture.mjs <pasta-fora-do-repo>`
   - `success` e `resume` usam o mesmo `--session-id`/`--resume`;
   - `error-result` usa um modelo inexistente;
   - `auth-error` roda com `CLAUDE_CONFIG_DIR` apontando para uma pasta vazia (CLI sem login), sem
     deslogar a sua conta.
2. Sanitize: `node apps/server/tests/fixtures/stream-json/tools/sanitize.mjs <pasta-fora-do-repo> apps/server/tests/fixtures/stream-json`
   - troca `session_id`/`uuid` por UUIDs fictícios fixos e ids `msg_`/`req_`/`toolu_` por ids fictícios;
   - troca o caminho do repositório temporário por `/repo` e a pasta do usuário por `/home/user`
     (inclusive dentro dos fragmentos `input_json_delta`, que são remontados antes);
   - remove `memory_paths`, `messaging_socket_path`, `powershell_path` e `credential_expires_at`, e
     substitui os dados de uso da conta do `rate_limit_event` por valores genéricos.
3. **Revise o diff antes de commitar** (o repositório é público). Procure, no mínimo:
   `grep -n -i -E "Users|AppData|<seu usuário>|<seu e-mail>|token|credential" apps/server/tests/fixtures/stream-json/*.jsonl`
   O resultado deve vir vazio. Os arquivos brutos ficam fora do repositório e não devem ser commitados.
