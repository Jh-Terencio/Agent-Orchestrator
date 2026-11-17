<!--
Sync Impact Report
- Version change: (template, sem versão) → 1.0.0
- Princípios definidos (primeira ratificação):
  I. Uso Pessoal e Local
  II. Segurança do Código Alvo (INEGOCIÁVEL)
  III. Simplicidade Primeiro
  IV. Pipeline como Dado
  V. Passos Pequenos e Verificáveis
  VI. Transparência em Tempo Real
  VII. Qualidade e Testes Obrigatórios (INEGOCIÁVEL)
  VIII. Custo Consciente
- Seções adicionadas: Restrições Técnicas; Fluxo de Desenvolvimento e Quality Gates; Governance
- Seções removidas: nenhuma
- Templates: nenhum template de origem foi alterado (os comandos leem a constituição em runtime)
- TODOs pendentes: nenhum
-->

# Agent Orchestrator Constitution

## Core Principles

### I. Uso Pessoal e Local

A aplicação MUST rodar inteiramente na máquina do usuário.

- Não há hospedagem, deploy em nuvem, autenticação de usuários nem multi-tenant.
- Servidores locais MUST escutar apenas em `localhost`/`127.0.0.1`.
- Funcionalidades que pressuponham múltiplos usuários (contas, permissões, isolamento de
  tenants) MUST NOT ser introduzidas.

**Racional**: o público é um único usuário em sua própria máquina; qualquer infraestrutura
de produto hospedado é custo e complexidade sem benefício.

### II. Segurança do Código Alvo (INEGOCIÁVEL)

Toda execução da esteira MUST acontecer em uma branch Git nova, criada para aquela execução,
no repositório alvo.

- O sistema MUST NOT fazer commit, push, reset, rebase ou merge na branch principal
  (ex.: `main`/`master`) do repositório alvo.
- O sistema MUST NOT fazer merge automaticamente; o merge é sempre uma ação manual do usuário
  após revisão.
- Antes de iniciar uma execução, o sistema MUST verificar que o repositório alvo é um
  repositório Git válido e recusar a execução caso a branch de trabalho não possa ser criada.

**Racional**: os agentes alteram código real; a branch isolada mais a revisão humana são a
garantia de que nada chega à branch principal sem aprovação explícita.

### III. Simplicidade Primeiro

Preferir a solução mais simples que funcione hoje.

- Abstrações, camadas e dependências novas MUST ser justificadas por uma necessidade
  presente, não por uma hipotética (YAGNI).
- Cada dependência externa adicionada MUST ter justificativa registrada no plano da
  funcionalidade.
- Complexidade que viole este princípio MUST ser registrada na tabela de
  *Complexity Tracking* do plano, com a alternativa mais simples rejeitada e o motivo.

**Racional**: um projeto pessoal evolui rápido; código simples é mais fácil de entender,
testar e de ser modificado com segurança por uma IA.

### IV. Pipeline como Dado

A esteira de agentes MUST ser definida por um modelo de dados declarativo em JSON.

- O modelo JSON é a única fonte da verdade da esteira.
- A interface MUST ser apenas uma visualização e um editor desse modelo; ela MUST NOT
  guardar estado da esteira que não exista no JSON.
- O modelo MUST ser validado por um schema explícito antes de ser executado ou salvo.
- Toda execução MUST ser reproduzível a partir do JSON da esteira e das entradas fornecidas.

**Racional**: dados declarativos são versionáveis, testáveis, diffáveis e editáveis fora da
UI; a UI pode mudar sem arriscar a definição da esteira.

### V. Passos Pequenos e Verificáveis

Cada funcionalidade MUST ser entregue em incrementos pequenos, testáveis e fáceis de revisar.

- Cada incremento MUST deixar o sistema em estado funcional, com a suíte de testes passando.
- Cada incremento MUST ter critério de verificação explícito (teste automatizado ou passo de
  validação descrito).
- Mudanças grandes MUST ser quebradas em tarefas independentes antes da implementação.

**Racional**: incrementos pequenos tornam a revisão viável, isolam regressões e permitem
interromper o trabalho a qualquer momento sem deixar o código quebrado.

### VI. Transparência em Tempo Real

O usuário MUST conseguir ver, em tempo real, o status, as entradas e as saídas de cada passo
da esteira.

- Cada passo MUST expor seu estado (ex.: pendente, em execução, concluído, falhou,
  interrompido).
- Entradas, saídas e erros de cada passo MUST ser registrados e consultáveis após a execução.
- Falhas MUST ser exibidas com mensagem compreensível e nunca silenciadas.

**Racional**: o usuário só pode confiar no que os agentes fazem se puder observar e auditar
cada passo.

### VII. Qualidade e Testes Obrigatórios (INEGOCIÁVEL)

- TypeScript MUST ser usado em modo `strict` no front-end e no back-end; uso de `any` MUST
  ser evitado e, quando inevitável, justificado em comentário.
- O código MUST ser legível: nomes claros, funções curtas e responsabilidades bem definidas.
- Testes unitários são obrigatórios: toda funcionalidade nova ou alterada MUST vir
  acompanhada de testes que a cubram.
- A suíte completa de testes MUST passar antes de uma tarefa ser considerada concluída.
- Testes MUST NOT ser removidos, desabilitados ou enfraquecidos para fazer uma mudança
  passar sem justificativa explícita revisada pelo usuário.

**Racional**: os testes são a rede de segurança que permite à IA evoluir o código e
detectar quando uma mudança quebrou algo que já funcionava.

### VIII. Custo Consciente

A execução consome os limites da assinatura do Claude; o sistema MUST permitir acompanhar e
interromper execuções.

- O usuário MUST conseguir interromper uma execução em andamento a qualquer momento, e a
  interrupção MUST encerrar os processos de agentes associados.
- O sistema MUST exibir o consumo disponível de cada execução e passo (ex.: duração,
  tokens ou uso reportado pelo Claude, quando disponível).
- O sistema MUST NOT reexecutar passos automaticamente em loop sem limite explícito
  definido no modelo da esteira.

**Racional**: execuções descontroladas esgotam a cota da assinatura; visibilidade e controle
evitam desperdício.

## Restrições Técnicas

- Linguagem: TypeScript (`strict`) em front-end e back-end.
- Execução: 100% local; nenhuma dependência de serviço hospedado próprio.
- Definição da esteira: arquivos JSON validados por schema.
- Integração Git: operações restritas a criar/usar branches de trabalho no repositório alvo;
  operações destrutivas na branch principal são proibidas (Princípio II).
- Dependências: mínimas e justificadas (Princípio III).

## Fluxo de Desenvolvimento e Quality Gates

- Funcionalidades seguem o fluxo Spec Kit: especificação → plano → tarefas → implementação.
- Todo plano MUST passar pelo *Constitution Check* antes da implementação, verificando os
  princípios I–VIII.
- Uma tarefa só é considerada concluída quando:
  1. Os testes da funcionalidade nova/alterada existem e passam.
  2. A suíte completa de testes passa.
  3. A checagem de tipos do TypeScript (`strict`) passa sem erros.
- Mudanças MUST ser revisáveis: diffs pequenos, focados em um objetivo.

## Governance

- Esta constituição prevalece sobre outras práticas e convenções do projeto.
- Emendas MUST ser feitas via `/speckit-constitution`, registradas neste arquivo com
  atualização de versão e data.
- Versionamento semântico da constituição:
  - MAJOR: remoção ou redefinição incompatível de princípios ou regras de governança.
  - MINOR: novo princípio/seção ou expansão material de orientação existente.
  - PATCH: esclarecimentos, redação e correções sem mudança semântica.
- Revisão de conformidade: todo plano (`plan.md`) e toda revisão de código MUST verificar a
  aderência aos princípios; violações MUST ser justificadas em *Complexity Tracking* ou
  corrigidas.

**Version**: 1.0.0 | **Ratified**: 2026-11-16 | **Last Amended**: 2026-11-16
