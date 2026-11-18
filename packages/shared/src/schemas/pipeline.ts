import { z } from "zod";

/** Limite de tempo por invocação do agente quando o passo não define `timeoutMinutes` (FR-018a). */
export const DEFAULT_TIMEOUT_MINUTES = 30;

const TIMEOUT_MESSAGE = "O limite de tempo deve estar entre 1 e 1440 minutos";
const COMMAND_MESSAGE = "Informe a skill ou comando do passo";
const PIPELINE_NAME_MESSAGE = "Informe um nome para a esteira";
const STEP_NAME_MESSAGE = "Informe um nome para o passo";
const STEPS_MIN_MESSAGE = "A esteira precisa de pelo menos um passo";
const DUPLICATE_STEP_MESSAGE = "Já existe um passo com este nome";

const stepFields = {
  name: z
    .string({ error: STEP_NAME_MESSAGE })
    .trim()
    .min(1, STEP_NAME_MESSAGE)
    .max(60, "O nome do passo deve ter no máximo 60 caracteres"),
  model: z.string({ error: "Informe o modelo do passo" }).trim().min(1, "Informe o modelo do passo"),
  command: z.string({ error: COMMAND_MESSAGE }).trim().min(1, COMMAND_MESSAGE),
  interactive: z.boolean().default(false),
  timeoutMinutes: z
    .number({ error: TIMEOUT_MESSAGE })
    .int(TIMEOUT_MESSAGE)
    .min(1, TIMEOUT_MESSAGE)
    .max(1440, TIMEOUT_MESSAGE)
    .optional(),
};

export const StepSchema = z.object({
  id: z.uuid(),
  ...stepFields,
});
export type Step = z.infer<typeof StepSchema>;

export const StepInputSchema = z.object({
  id: z.uuid().optional(),
  ...stepFields,
});
export type StepInput = z.infer<typeof StepInputSchema>;

const pipelineName = z
  .string({ error: PIPELINE_NAME_MESSAGE })
  .trim()
  .min(1, PIPELINE_NAME_MESSAGE)
  .max(80, "O nome da esteira deve ter no máximo 80 caracteres");

/** Nomes de passo únicos dentro da esteira (FR-024); o erro aponta para cada repetição. */
function checkUniqueStepNames(steps: readonly { name: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (seen.has(step.name)) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "name"], message: DUPLICATE_STEP_MESSAGE });
    }
    seen.add(step.name);
  });
}

export const PipelineSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: pipelineName,
    isDefault: z.boolean(),
    steps: z.array(StepSchema).min(1, STEPS_MIN_MESSAGE),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((pipeline, ctx) => checkUniqueStepNames(pipeline.steps, ctx));
export type Pipeline = z.infer<typeof PipelineSchema>;

export const PipelineInputSchema = z
  .object({
    name: pipelineName,
    steps: z.array(StepInputSchema).min(1, STEPS_MIN_MESSAGE),
  })
  .superRefine((input, ctx) => checkUniqueStepNames(input.steps, ctx));
export type PipelineInput = z.infer<typeof PipelineInputSchema>;
