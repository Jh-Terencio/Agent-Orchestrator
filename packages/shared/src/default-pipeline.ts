import type { Pipeline } from "./schemas/pipeline.js";

export const DEFAULT_PIPELINE_ID = "00000000-0000-4000-8000-000000000001";

/** Esteira padrão do Spec Kit (FR-020, data-model.md "Esteira padrão"). Ids fixos para serem estáveis entre instalações. */
export function createDefaultPipeline(now: string): Pipeline {
  return {
    schemaVersion: 1,
    id: DEFAULT_PIPELINE_ID,
    name: "Spec Kit (padrão)",
    isDefault: true,
    createdAt: now,
    updatedAt: now,
    steps: [
      {
        id: "00000000-0000-4000-8000-000000000101",
        name: "Specify",
        command: "/speckit-specify",
        model: "sonnet",
        interactive: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000102",
        name: "Clarify",
        command: "/speckit-clarify",
        model: "sonnet",
        interactive: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000103",
        name: "Plan",
        command: "/speckit-plan",
        model: "opus",
        interactive: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000104",
        name: "Tasks",
        command: "/speckit-tasks",
        model: "sonnet",
        interactive: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000105",
        name: "Implement",
        command: "/speckit-implement",
        model: "sonnet",
        interactive: true,
        timeoutMinutes: 120,
      },
    ],
  };
}
