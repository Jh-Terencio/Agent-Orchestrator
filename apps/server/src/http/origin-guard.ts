import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { ApiError } from "./errors.js";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Aceita só `http://127.0.0.1:<porta>` e `http://localhost:<porta>` (porta do servidor ou do Vite em dev),
 * ou ausência de `Origin` (ex.: curl). Protege contra outra aba disparar ações (research R7).
 */
export function isAllowedOrigin(origin: string | undefined, port: number, devPorts: readonly number[]): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOCAL_HOSTNAMES.has(url.hostname)) return false;
  if (url.origin !== origin) return false; // sem caminho, usuário ou senha
  const urlPort = effectivePort(url);
  return urlPort === port || devPorts.includes(urlPort);
}

/** `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>` (proteção contra DNS rebinding). */
export function isAllowedHost(host: string | undefined, port: number, devPorts: readonly number[] = []): boolean {
  if (!host) return false;
  return isAllowedOrigin(`http://${host}`, port, devPorts);
}

export interface OriginGuardOptions {
  /** Porta real do servidor (lida depois do `listen`, para suportar porta efêmera). */
  getPort: () => number;
  devPorts: readonly number[];
}

/** Verificação compartilhada entre o middleware HTTP e o `upgrade` do WebSocket. */
export function isAllowedRequest(req: IncomingMessage, options: OriginGuardOptions): boolean {
  const port = options.getPort();
  const origin = req.headers.origin;
  return isAllowedHost(req.headers.host, port, options.devPorts) && isAllowedOrigin(origin, port, options.devPorts);
}

export function originGuard(options: OriginGuardOptions): RequestHandler {
  return (req, _res, next) => {
    if (isAllowedRequest(req, options)) next();
    else next(new ApiError(403, "FORBIDDEN_ORIGIN", "Origem não permitida: o orquestrador só aceita acesso local"));
  };
}
