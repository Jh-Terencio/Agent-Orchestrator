# Feature Specification: Orquestrador Visual de Esteira de Agentes

**Feature Branch**: `001-agent-pipeline-orchestrator`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Quero construir um orquestrador visual de agentes de IA para uso pessoal, que execute uma esteira de desenvolvimento de software sobre um repositório local. Problema: hoje, para implementar uma feature com ajuda de IA usando um fluxo estruturado (como o Spec Kit), preciso disparar cada etapa manualmente. Quero descrever a feature uma vez e deixar uma esteira de agentes executar todas as etapas em sequência. [...] Fora do escopo nesta primeira versão: hospedagem, múltiplos usuários, execução de passos em paralelo e passos condicionais. Critérios de sucesso: consigo descrever uma feature, enviar e ver a esteira padrão do Spec Kit rodar do início ao fim em um repositório local; consigo acompanhar o progresso e a saída de cada passo em tempo real; nenhuma alteração é feita fora de uma branch criada pela execução."

## Clarifications

### Session 2026-11-17

- Q: Quais branches o orquestrador pode alterar durante uma execução, sabendo que o passo Specify do Spec Kit cria uma branch própria e troca para ela? → A: A branch de origem e as branches pré-existentes nunca são alteradas; qualquer branch criada durante a execução (pelo orquestrador ou pelos passos) faz parte da execução; o orquestrador faz commit na branch ativa ao fim de cada passo e informa ao final em qual branch o resultado ficou; se um passo terminar com o repositório em uma branch pré-existente, o passo falha e nada é commitado.
- Q: Como deve funcionar um passo marcado como interativo (por exemplo, o Clarify) quando ele termina? → A: A definição da esteira permite marcar um passo como interativo; ao terminar, a esteira pausa em "aguardando resposta" e mostra a saída; o usuário pode responder quantas vezes quiser (cada resposta continua a mesma sessão do agente) ou avançar a qualquer momento; o commit ocorre ao avançar; o Clarify vem marcado como interativo na esteira padrão; a pausa não expira e interromper continua disponível.
- Q: O que o usuário deve conseguir fazer com as execuções anteriores na primeira versão? → A: Ver uma lista de execuções anteriores (mais recente primeiro, com data, repositório, esteira, início da descrição, status final e branch do resultado) e abrir qualquer uma em modo somente leitura na mesma visualização de caixas; sem busca, exclusão ou reexecução; histórico mantido por tempo indeterminado.
- Q: Como deve funcionar o limite de tempo de um passo, para que nenhum passo rode indefinidamente? → A: Limite opcional por passo na definição da esteira, com padrão de 30 minutos quando não definido (Implement com 120 minutos na esteira padrão); conta apenas o tempo de trabalho do agente (a execução inicial e cada resposta de passo interativo recebem o limite completo; a pausa "aguardando resposta" não conta); ao estourar, o passo é encerrado como uma interrupção do usuário, fica "interrompido" com motivo "tempo limite excedido" e a esteira para.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Executar a esteira padrão do Spec Kit de ponta a ponta (Priority: P1)

O usuário abre o orquestrador, seleciona um repositório local já clonado, digita no campo de texto do topo da tela a descrição de uma feature e clica em enviar. O sistema cria uma branch nova no repositório e executa, em ordem, os passos da esteira padrão (Specify, Clarify, Plan, Tasks, Implement). Cada passo trabalha sobre o mesmo repositório e aproveita os artefatos produzidos pelos passos anteriores. Ao final, todas as alterações estão na branch nova, prontas para revisão manual.

**Why this priority**: É o motivo de existir do produto: eliminar o disparo manual de cada etapa. Sem isso não há valor entregue.

**Independent Test**: Selecionar um repositório Git de teste, enviar uma descrição simples de feature e verificar que os cinco passos terminam como concluídos, que existe uma branch nova contendo os artefatos e o código gerados, e que a branch de origem não foi alterada.

**Acceptance Scenarios**:

1. **Given** um repositório Git local válido selecionado e a esteira padrão ativa, **When** o usuário descreve uma feature e clica em enviar, **Then** o sistema cria uma branch nova dedicada à execução e inicia o primeiro passo.
2. **Given** uma execução em andamento, **When** um passo termina com sucesso, **Then** o passo seguinte inicia automaticamente, com acesso aos artefatos gerados pelos passos anteriores.
3. **Given** que todos os passos terminaram com sucesso, **When** a execução é finalizada, **Then** todas as alterações estão registradas em branches criadas pela execução e o sistema informa ao usuário em qual branch o resultado final ficou.
4. **Given** uma execução concluída, **When** o usuário inspeciona a branch de origem e as demais branches que já existiam antes da execução, **Then** elas estão exatamente como antes da execução.
5. **Given** que o passo Specify criou uma branch própria e trocou para ela, **When** o passo termina, **Then** o orquestrador faz o commit nessa branch (que passa a fazer parte da execução) e os passos seguintes continuam a partir dela.
6. **Given** que o passo interativo Clarify terminou e a esteira está em "aguardando resposta", **When** o usuário envia uma resposta, **Then** o agente continua a mesma sessão com essa resposta e, ao terminar, a esteira volta a "aguardando resposta".
7. **Given** um passo em "aguardando resposta", **When** o usuário clica em avançar, **Then** o orquestrador faz o commit das alterações do passo, marca-o como concluído e inicia o passo seguinte.
8. **Given** que o usuário selecionou um repositório, **When** ainda não enviou a descrição, **Then** a tela mostra a branch atualmente em uso nesse repositório, a partir da qual a nova execução vai partir.

---

### User Story 2 - Acompanhar progresso e saída de cada passo em tempo real (Priority: P1)

Enquanto a esteira roda, o usuário vê abaixo do campo de entrada uma sequência de caixas, uma por passo. Cada caixa mostra o status do passo (aguardando, executando, aguardando resposta, concluído, com erro ou interrompido) e permite abrir a saída daquele passo, que é atualizada à medida que é produzida.

**Why this priority**: Sem visibilidade, o usuário não confia no que os agentes estão fazendo nem sabe quando intervir. É critério de sucesso explícito e princípio da constituição (Transparência em Tempo Real).

**Independent Test**: Iniciar uma execução e verificar que os status das caixas mudam conforme o progresso e que a saída do passo em execução aparece incrementalmente, sem precisar esperar o passo terminar.

**Acceptance Scenarios**:

1. **Given** uma execução iniciada, **When** um passo está rodando, **Then** sua caixa exibe o status "executando" e os passos posteriores exibem "aguardando".
2. **Given** um passo em execução, **When** o usuário abre a saída desse passo, **Then** vê o conteúdo produzido até o momento, atualizado continuamente.
3. **Given** um passo que falhou, **When** o usuário olha sua caixa, **Then** ela exibe "com erro" e uma mensagem compreensível do motivo da falha, e os passos seguintes não são executados.
4. **Given** uma execução finalizada (com sucesso, erro ou interrupção), **When** o usuário abre a saída de qualquer passo, **Then** a saída completa daquele passo continua disponível para consulta.
5. **Given** um passo concluído, **When** o usuário olha sua caixa, **Then** vê a duração do passo e o consumo reportado pelo modelo de IA, quando disponível.

---

### User Story 3 - Interromper uma execução (Priority: P2)

A qualquer momento durante a execução, o usuário pode clicar em interromper. O passo em andamento é encerrado, nenhum passo seguinte é iniciado e o que já foi produzido permanece nas branches criadas pela execução.

**Why this priority**: Protege a cota de uso do modelo e permite corrigir rumo quando o usuário percebe que a descrição estava errada. É exigência da constituição (Custo Consciente).

**Independent Test**: Iniciar uma execução, interromper durante o segundo passo e verificar que o processo do agente foi encerrado, que o passo aparece como "interrompido", que os passos seguintes não rodaram e que a branch de origem não foi alterada.

**Acceptance Scenarios**:

1. **Given** um passo em execução, **When** o usuário clica em interromper, **Then** o trabalho do agente desse passo é encerrado em até 5 segundos e o passo é marcado como "interrompido".
2. **Given** uma execução interrompida, **When** o usuário observa a esteira, **Then** os passos que não chegaram a rodar permanecem como "aguardando" (não executados) e nenhum novo passo é iniciado.
3. **Given** uma execução interrompida, **When** o usuário inspeciona o repositório, **Then** as alterações parciais estão somente em branches criadas pela execução, commitadas na branch ativa com uma mensagem que as identifica como parciais (ex.: "WIP: passo Plan interrompido"), e o repositório fica sem alterações pendentes.
4. **Given** um passo com limite de tempo de 30 minutos, **When** o agente trabalha por 30 minutos sem terminar, **Then** o passo é encerrado como numa interrupção do usuário, marcado como "interrompido" com o motivo "tempo limite excedido", e nenhum passo seguinte é iniciado.

---

### User Story 4 - Criar, editar, reordenar e salvar esteiras personalizadas (Priority: P3)

O usuário cria uma esteira nova ou edita uma existente: adiciona ou remove passos, define para cada passo um nome, um modelo de IA e uma skill ou comando, reordena os passos e salva a esteira com um nome. Depois, pode escolher qual esteira salva usar em uma execução, inclusive esteiras que usam skills diferentes do Spec Kit.

**Why this priority**: Amplia o produto para outros fluxos, mas a esteira padrão já entrega o valor principal.

**Independent Test**: Criar uma esteira com dois passos usando skills distintas do Spec Kit, salvar, fechar e reabrir o orquestrador, selecionar a esteira salva e executá-la com sucesso em um repositório de teste.

**Acceptance Scenarios**:

1. **Given** o editor de esteiras aberto, **When** o usuário adiciona um passo e preenche nome, modelo e skill/comando, **Then** o passo aparece na sequência de caixas na posição escolhida.
2. **Given** uma esteira com vários passos, **When** o usuário move um passo para outra posição, **Then** a nova ordem é refletida na visualização e é a ordem usada na próxima execução.
3. **Given** uma esteira editada, **When** o usuário salva, **Then** a esteira fica disponível na lista de esteiras salvas, inclusive após reiniciar a aplicação.
4. **Given** uma esteira com dados inválidos (ex.: passo sem skill/comando, nome vazio ou nenhum passo), **When** o usuário tenta salvar ou executar, **Then** o sistema recusa e indica claramente o que precisa ser corrigido.
5. **Given** a esteira padrão do Spec Kit, **When** o usuário a abre pela primeira vez, **Then** ela já existe pronta para uso, sem configuração prévia.

---

### User Story 5 - Consultar execuções anteriores (Priority: P3)

O usuário abre o histórico e vê a lista de execuções anteriores, da mais recente para a mais antiga. Ao selecionar uma, ela é exibida na mesma visualização de caixas da esteira, em modo somente leitura, com o status, a saída, as respostas, os erros, a duração e o consumo de cada passo.

**Why this priority**: Permite auditar o que os agentes fizeram depois do fato (constituição, Transparência em Tempo Real), mas não é necessário para executar a esteira.

**Independent Test**: Executar duas esteiras (uma concluída e uma interrompida), reiniciar a aplicação, abrir o histórico e verificar que ambas aparecem na ordem correta e que a saída de cada passo pode ser consultada.

**Acceptance Scenarios**:

1. **Given** execuções anteriores registradas, **When** o usuário abre o histórico, **Then** vê a lista ordenada da mais recente para a mais antiga, com data, repositório, nome da esteira, início da descrição, status final e branch do resultado de cada execução.
2. **Given** a lista do histórico, **When** o usuário seleciona uma execução, **Then** ela é exibida na visualização de caixas em modo somente leitura, com os dados completos de cada passo.
3. **Given** uma execução aberta a partir do histórico, **When** o usuário tenta editá-la ou reexecutá-la, **Then** não há essas opções; a visualização é apenas para consulta.
4. **Given** nenhuma execução registrada, **When** o usuário abre o histórico, **Then** vê uma mensagem indicando que ainda não há execuções.

---

### Edge Cases

- **Pasta selecionada não é um repositório Git**: o sistema recusa a execução antes de iniciar qualquer passo e explica o motivo.
- **Repositório com alterações não commitadas**: o sistema recusa iniciar a execução e informa o usuário, para evitar misturar trabalho local em andamento com o trabalho dos agentes.
- **Branch da execução não pode ser criada** (ex.: nome já existe, repositório em estado de merge/rebase): o sistema recusa a execução e informa o motivo; nenhum passo é iniciado.
- **Passo cria uma branch nova e troca para ela** (ex.: Specify do Spec Kit): permitido; a nova branch passa a fazer parte da execução e recebe os commits seguintes.
- **Passo termina com o repositório em uma branch pré-existente** (ex.: volta para a branch de origem): o passo é marcado como "com erro", nada é commitado e a esteira para.
- **Campo de descrição vazio**: o botão de enviar não dispara a execução e o usuário é avisado.
- **Passo que referencia uma skill ou comando inexistente no repositório/ambiente**: o passo falha com mensagem clara e a esteira para.
- **Passo que termina sem erro mas sem produzir o artefato esperado**: o passo seguinte roda normalmente; se ele falhar por falta do artefato, a falha é exibida nesse passo.
- **Passo interativo aguardando resposta por tempo indefinido**: a pausa não expira; a execução permanece em "aguardando resposta" até o usuário responder, avançar ou interromper.
- **Interrupção durante "aguardando resposta"**: o passo é marcado como "interrompido", as alterações já feitas pelo passo são commitadas como parciais na branch ativa da execução (FR-010a), e nenhum passo seguinte é iniciado.
- **Passo interrompido ou com erro sem nenhuma alteração**: nenhum commit é criado.
- **Passo atinge o limite de tempo**: tratado como interrupção do usuário (ver FR-018a); a caixa mostra "interrompido" com o motivo "tempo limite excedido".
- **Passo interativo aguardando resposta por muito tempo**: a pausa não conta para o limite de tempo; ao receber uma resposta, o agente volta a ter o limite completo para processá-la.
- **Passo não interativo que faz perguntas ao usuário**: as perguntas aparecem apenas na saída; a esteira não pausa e segue para o próximo passo.
- **Aplicação fechada durante uma execução**: a execução é encerrada como numa interrupção do usuário (os processos de agentes são finalizados e as alterações parciais são commitadas conforme FR-010a) e, ao reabrir, ela aparece como interrompida no histórico, com as saídas registradas até aquele ponto.
- **Tentativa de iniciar uma segunda execução enquanto outra está em andamento**: o sistema não permite; apenas uma execução por vez.
- **Ferramenta de agente de IA indisponível ou não autenticada na máquina**: o primeiro passo falha com mensagem orientando o usuário a corrigir a configuração.

## Requirements *(mandatory)*

### Functional Requirements

**Repositório e entrada**

- **FR-001**: Usuários MUST ser capazes de selecionar um repositório local existente na máquina como alvo da execução.
- **FR-002**: O sistema MUST validar, antes de iniciar a execução, que o alvo é um repositório Git válido, sem alterações não commitadas e sem operação de merge/rebase em andamento.
- **FR-003**: A tela MUST exibir no topo um campo de texto para a descrição da feature e um botão de enviar; o envio MUST ser bloqueado quando a descrição estiver vazia.
- **FR-003a**: Após a seleção de um repositório, a tela MUST exibir, antes do envio, o nome da branch atualmente em uso nesse repositório, indicando que a nova execução partirá dela (FR-004); a informação MUST ser atualizada sempre que outro repositório for selecionado e verificada novamente no momento do envio.

**Execução da esteira**

- **FR-004**: Ao enviar, o sistema MUST criar uma branch nova no repositório alvo, a partir da branch atualmente em uso, com nome único e identificável como pertencente à execução, antes de iniciar qualquer passo.
- **FR-005**: O sistema MUST executar os passos da esteira estritamente em sequência, um de cada vez, na ordem definida.
- **FR-006**: Cada passo MUST executar sobre o mesmo repositório, na branch ativa da execução (FR-011), com o modelo de IA e a skill/comando configurados para ele; o primeiro passo MUST receber a descrição da feature enviada pelo usuário.
- **FR-007**: Cada passo MUST ter acesso aos artefatos produzidos pelos passos anteriores da mesma execução.
- **FR-008**: Se um passo falhar, o sistema MUST interromper a esteira, marcar o passo como "com erro", exibir a mensagem de erro, commitar as alterações parciais conforme FR-010a e não iniciar os passos seguintes.
- **FR-009**: A definição da esteira MUST permitir marcar cada passo como interativo. Quando um passo interativo termina, a esteira MUST pausar no estado "aguardando resposta" e exibir a saída do passo. O usuário MUST poder (a) enviar uma resposta, que continua a mesma sessão do agente, quantas vezes quiser, ou (b) avançar a qualquer momento. A pausa MUST NOT expirar, e interromper continua disponível durante ela.
- **FR-009a**: Para passos interativos, o commit de FR-010 MUST ocorrer quando o usuário avançar, e não a cada resposta.
- **FR-010**: Ao fim de cada passo concluído, o sistema MUST registrar as alterações como commit na branch ativa naquele momento, desde que ela seja uma branch criada pela execução.
- **FR-010a**: Quando um passo for interrompido (pelo usuário, por tempo limite ou pelo fechamento da aplicação) ou falhar, o sistema MUST commitar as alterações parciais na branch ativa da execução, com uma mensagem que identifique o passo e deixe claro que o conteúdo é parcial (ex.: "WIP: passo Plan interrompido", "WIP: passo Implement com erro"), deixando o repositório sem alterações pendentes. Se não houver alterações, nenhum commit é criado. Se a branch ativa for pré-existente (FR-011a), nada é commitado.
- **FR-011**: A branch de origem e todas as branches que já existiam antes da execução MUST NOT ser alteradas (nenhum commit, push, merge, reset ou rebase). Qualquer branch criada durante a execução, pelo orquestrador ou por um passo, faz parte da execução e pode receber commits. O merge é sempre uma ação manual do usuário.
- **FR-011a**: O sistema MUST registrar quais branches existiam antes da execução e, ao fim de cada passo, verificar a branch ativa; se ela for uma branch pré-existente, o passo MUST ser marcado como "com erro", nada é commitado e a esteira para.
- **FR-012**: O sistema MUST permitir apenas uma execução ativa por vez.

**Visualização e acompanhamento**

- **FR-013**: A esteira MUST ser exibida como uma sequência de caixas, uma por passo, abaixo do campo de entrada, mostrando nome, modelo e skill/comando de cada passo.
- **FR-014**: Cada caixa MUST exibir o status atual do passo: aguardando, executando, aguardando resposta (somente passos interativos), concluído, com erro ou interrompido.
- **FR-015**: Usuários MUST ser capazes de abrir a saída de qualquer passo; a saída de um passo em execução MUST ser atualizada em tempo real conforme é produzida.
- **FR-016**: O sistema MUST registrar entrada, saída, erros, duração e consumo reportado (quando disponível) de cada passo, e mantê-los consultáveis após o fim da execução, inclusive após reiniciar a aplicação.
- **FR-016a**: O sistema MUST oferecer um histórico que lista as execuções anteriores, da mais recente para a mais antiga, exibindo data, repositório, nome da esteira, início da descrição, status final e branch do resultado.
- **FR-016b**: Usuários MUST ser capazes de abrir qualquer execução do histórico na mesma visualização de caixas, em modo somente leitura, com status, saída, respostas, erros, duração e consumo de cada passo.
- **FR-016c**: O histórico MUST ser mantido por tempo indeterminado. Busca, exclusão e reexecução a partir do histórico estão fora do escopo desta versão.
- **FR-017**: Ao final da execução, o sistema MUST exibir o resultado geral (concluída, com erro ou interrompida), o nome da branch em que o resultado final ficou e a lista de branches criadas pela execução.

**Interrupção**

- **FR-018**: Usuários MUST ser capazes de interromper a execução a qualquer momento; a interrupção MUST encerrar o processo do agente do passo em andamento e impedir o início de novos passos.
- **FR-018a**: Cada passo MUST ter um limite de tempo, configurável na definição da esteira, com padrão de 30 minutos quando não definido. O limite MUST contar apenas o tempo em que o agente está trabalhando: a execução inicial e cada resposta de um passo interativo recebem o limite completo, e a pausa em "aguardando resposta" não conta. Ao atingir o limite, o sistema MUST encerrar o passo exatamente como em FR-018, marcá-lo como "interrompido" com o motivo "tempo limite excedido" e parar a esteira.
- **FR-019**: O sistema MUST NOT reexecutar passos automaticamente.

**Gestão de esteiras**

- **FR-020**: O sistema MUST fornecer, já pronta, uma esteira padrão com os passos Specify, Clarify, Plan, Tasks e Implement, baseada no Spec Kit, com o passo Clarify marcado como interativo e o passo Implement com limite de tempo de 120 minutos.
- **FR-021**: Usuários MUST ser capazes de criar, editar (nome, modelo, skill/comando, marcação de interativo e limite de tempo de cada passo), adicionar e remover passos, reordenar passos, salvar, duplicar e excluir esteiras.
- **FR-022**: Usuários MUST ser capazes de escolher qual esteira salva será usada antes de enviar uma execução.
- **FR-023**: Cada esteira MUST ser armazenada como uma definição declarativa legível, que é a única fonte da verdade da esteira; a interface MUST apenas visualizar e editar essa definição.
- **FR-024**: O sistema MUST validar a definição da esteira antes de salvá-la ou executá-la, recusando definições inválidas com indicação do problema.
- **FR-025**: As esteiras salvas MUST persistir entre reinícios da aplicação.

**Ambiente**

- **FR-026**: A aplicação MUST rodar inteiramente na máquina do usuário e ser acessível apenas localmente.

### Key Entities

- **Esteira (Pipeline)**: Sequência nomeada e ordenada de passos. Atributos: nome, lista ordenada de passos, indicador de esteira padrão. É salva como definição declarativa reutilizável.
- **Passo (Step)**: Unidade da esteira. Atributos: nome, modelo de IA, skill ou comando a executar, posição na esteira, indicador de interativo, limite de tempo (opcional; padrão de 30 minutos).
- **Execução (Run)**: Uma aplicação de uma esteira a um repositório. Atributos: esteira usada (cópia da definição no momento do envio), repositório alvo, descrição da feature, branch de origem, branches pré-existentes no início, branches criadas durante a execução, branch final do resultado, status geral, horário de início/fim.
- **Execução de Passo (Step Run)**: Registro de um passo dentro de uma execução. Atributos: passo correspondente, status, saída, respostas enviadas pelo usuário (passos interativos), mensagem de erro, motivo da interrupção (usuário ou tempo limite excedido), duração, consumo reportado.
- **Repositório Alvo**: Repositório Git local selecionado pelo usuário. Atributos: caminho na máquina, branch atual.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O usuário consegue, em uma única ação de envio, executar a esteira padrão do Spec Kit do início ao fim em um repositório local, sem disparar nenhuma etapa manualmente; as únicas intervenções são responder ou avançar nos passos interativos.
- **SC-002**: A partir do momento em que abre o orquestrador, o usuário consegue selecionar um repositório, descrever uma feature e iniciar a execução em menos de 1 minuto.
- **SC-003**: A saída de um passo em execução aparece para o usuário em até 2 segundos após ser produzida.
- **SC-004**: Mudanças de status dos passos são refletidas na interface em até 2 segundos.
- **SC-005**: Após clicar em interromper, ou ao atingir o limite de tempo, o passo em andamento é encerrado em até 5 segundos e nenhum passo adicional é iniciado.
- **SC-006**: Em 100% das execuções (concluídas, com erro ou interrompidas), a branch de origem e as demais branches pré-existentes do repositório permanecem inalteradas.
- **SC-007**: O usuário consegue criar e salvar uma esteira nova com 3 passos em menos de 3 minutos.
- **SC-008**: 100% das saídas e erros dos passos de uma execução continuam consultáveis após o fim da execução e após reiniciar a aplicação.

## Assumptions

- O usuário é único e usa a aplicação apenas na própria máquina; não há autenticação, contas nem hospedagem (constituição, Princípio I).
- A ferramenta de agente de IA que executa os passos já está instalada e autenticada na máquina do usuário, usando a assinatura dele; o orquestrador não gerencia credenciais.
- As skills/comandos referenciados pelos passos (ex.: os do Spec Kit) já estão disponíveis no repositório alvo ou no ambiente do agente; o orquestrador não os instala.
- Os modelos de IA disponíveis para escolha em cada passo são os oferecidos pela ferramenta de agente instalada.
- A descrição da feature é entregue como entrada ao primeiro passo; os passos seguintes obtêm o contexto a partir dos artefatos no repositório (como o Spec Kit já faz), e não do texto de saída dos passos anteriores.
- A branch inicial da execução é criada pelo orquestrador a partir da branch atualmente em uso no repositório alvo; passos podem criar outras branches a partir dela.
- Em caso de falha ou interrupção, as alterações parciais são commitadas como WIP na branch ativa da execução (FR-010a) e não são revertidas; o usuário decide o que fazer com elas. Isso mantém o repositório limpo para que a próxima execução não seja bloqueada pela verificação de alterações pendentes (FR-002).
- Retomar uma execução a partir do passo que falhou não faz parte desta versão; o usuário inicia uma nova execução.
- O sistema não envia a branch para nenhum repositório remoto (push); a revisão é feita localmente.
- Fora do escopo nesta versão: hospedagem, múltiplos usuários, execução de passos em paralelo, passos condicionais e busca, exclusão ou reexecução a partir do histórico.
