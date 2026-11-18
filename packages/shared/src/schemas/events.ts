import { z } from "zod";
import { OutputEntrySchema, RunSchema } from "./run.js";

/** Eventos servidor → cliente do WebSocket (contracts/websocket-events.md). */
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), activeRun: RunSchema.nullable() }),
  z.object({ type: z.literal("run.updated"), run: RunSchema }),
  z.object({
    type: z.literal("step.output"),
    runId: z.uuid(),
    stepIndex: z.number().int().nonnegative(),
    entries: z.array(OutputEntrySchema),
  }),
  z.object({ type: z.literal("run.finished"), run: RunSchema }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
