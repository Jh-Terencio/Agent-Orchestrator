export { toApiIssues } from "../http/errors.js";

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const UUID_LIKE = /^[0-9a-fA-F-]{36}$/;

/** Impede que um id vindo da URL vire caminho fora da pasta de dados (ex.: `../`). */
export function isSafeId(id: string): boolean {
  return UUID_LIKE.test(id);
}
