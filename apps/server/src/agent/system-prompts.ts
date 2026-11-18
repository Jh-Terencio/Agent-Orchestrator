/**
 * Adicionado (não substitui o system prompt padrão) só em passos não interativos, para que o agente
 * não pare com uma pergunta e gere um falso "concluído" (FR-006a, research R2a).
 */
export const NON_INTERACTIVE_SYSTEM_PROMPT =
  "Você está rodando sem usuário presente, numa esteira automatizada. Não faça perguntas nem aguarde confirmação. " +
  "Quando houver dúvida, escolha a opção mais razoável, registre a dúvida nos artefatos (ex.: marcador [NEEDS CLARIFICATION]) " +
  "e conclua o trabalho do comando.";
