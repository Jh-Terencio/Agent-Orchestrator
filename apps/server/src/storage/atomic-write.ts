import { rename, writeFile } from "node:fs/promises";

/** Grava `<path>.tmp` e faz `rename`, para nunca deixar um JSON pela metade (research R8). */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
