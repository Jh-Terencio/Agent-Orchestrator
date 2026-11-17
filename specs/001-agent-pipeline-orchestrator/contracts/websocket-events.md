# Contrato WebSocket: eventos em tempo real

Endpoint: `ws://127.0.0.1:4317/ws` (mesma validação de `Origin` da API REST).
Mensagens são JSON validadas pelo schema `ServerEvent` (união discriminada por `type`) em `@orchestrator/shared`.
Canal **servidor → cliente**. As ações do usuário vão pela API REST.

## Eventos do servidor

| `type` | Payload | Quando |
|---|---|---|
| `hello` | `{ activeRun: Run \| null }` | logo após a conexão (estado inicial / reconexão) |
| `run.updated` | `{ run: Run }` | qualquer mudança de status da execução ou de passo, branch criada, commit, consumo. Envia o snapshot completo (execuções são pequenas, o que simplifica o cliente) |
| `step.output` | `{ runId, stepIndex, entries: OutputEntry[] }` | lotes de saída a cada ≤ 250 ms enquanto o agente produz (SC-003) |
| `run.finished` | `{ run: Run }` | estado terminal (`completed`/`failed`/`interrupted`), com `finalBranch` e `createdBranches` (FR-017) |

## Regras

- O cliente mantém, por passo, o maior `seq` recebido. Depois de reconectar, chama `GET /runs/:id/steps/:i/output?afterSeq=<n>` para preencher lacunas e ignora entradas com `seq` já visto.
- O servidor faz *broadcast* para todos os clientes conectados (uso pessoal, normalmente uma única aba).
- Latência-alvo: mudanças de status e saída chegam em ≤ 2 s (SC-003/SC-004). O envio acontece no mesmo *tick* em que o estado é persistido.
