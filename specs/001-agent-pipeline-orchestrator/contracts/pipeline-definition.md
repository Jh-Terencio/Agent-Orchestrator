# Contrato: definição declarativa de esteira (JSON)

Formato persistido em `<dataDir>/pipelines/<id>.json`, validado pelo `PipelineSchema` (Zod) em
`@orchestrator/shared` ao salvar, ao ler do disco e antes de executar (FR-023/FR-024, Princípio IV).
Campos e regras: [data-model.md §1–2](../data-model.md).

## Exemplo: esteira padrão do Spec Kit (FR-020)

```json
{
  "schemaVersion": 1,
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Spec Kit (padrão)",
  "isDefault": true,
  "createdAt": "2026-11-17T00:00:00.000Z",
  "updatedAt": "2026-11-17T00:00:00.000Z",
  "steps": [
    { "id": "…", "name": "Specify",   "model": "sonnet", "command": "/speckit-specify",   "interactive": false },
    { "id": "…", "name": "Clarify",   "model": "sonnet", "command": "/speckit-clarify",   "interactive": true  },
    { "id": "…", "name": "Plan",      "model": "opus",   "command": "/speckit-plan",      "interactive": false },
    { "id": "…", "name": "Tasks",     "model": "sonnet", "command": "/speckit-tasks",     "interactive": false },
    { "id": "…", "name": "Implement", "model": "sonnet", "command": "/speckit-implement", "interactive": true,  "timeoutMinutes": 120 }
  ]
}
```

- **Modelos**: Opus só no Plan, onde o raciocínio mais pesa, e Sonnet nos demais passos, para poupar os limites da assinatura (Princípio VIII). Os modelos são editáveis por passo.
- **Interativos**: Clarify (perguntas de esclarecimento) e Implement (confirmação de checklists incompletos e revisão antes do commit final). Passos não interativos recebem a instrução de não fazer perguntas (FR-006a).

## Mensagens de validação esperadas (exemplos)

| Entrada | `issues[].path` | Mensagem |
|---|---|---|
| `"name": ""` | `["name"]` | "Informe um nome para a esteira" |
| `"steps": []` | `["steps"]` | "A esteira precisa de pelo menos um passo" |
| passo sem `command` | `["steps", i, "command"]` | "Informe a skill ou comando do passo" |
| `timeoutMinutes: 0` | `["steps", i, "timeoutMinutes"]` | "O limite de tempo deve estar entre 1 e 1440 minutos" |
| dois passos com o mesmo nome | `["steps", i, "name"]` | "Já existe um passo com este nome" |
