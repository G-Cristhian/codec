import { CodecError } from "./errors.js";
import { S } from "./strings.js";

export const CONNECTIONS = [
  { id: "github", fields: ["token"] },
  { id: "canvas", fields: ["instanceUrl", "token"] },
] as const;
export type ConnectionId = typeof CONNECTIONS[number]["id"];
export type ConnectionField = typeof CONNECTIONS[number]["fields"][number];
export interface ProjectConnection { id: ConnectionId; connected: boolean }
export interface ConnectionInput { token: string; instanceUrl?: string }

export function requireConnection(id: string) {
  const connection = CONNECTIONS.find((entry) => entry.id === id);
  if (!connection) throw new CodecError("connection_not_found", S.errors.connection_not_found, {}, 404);
  return connection;
}

/** Stage 1 stub: all connections are disconnected; reads nothing from disk. */
export function projectConnections(_project: string): ProjectConnection[] {
  return CONNECTIONS.map(({ id }) => ({ id, connected: false }));
}

export function validateConnectionInput(id: string, body: unknown): void {
  const connection = requireConnection(id);
  const invalid = () => new CodecError("invalid_connection", S.errors.invalid_connection);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const fields = body as Record<string, unknown>;
  for (const field of connection.fields) {
    if (typeof fields[field] !== "string" || !fields[field].trim()) throw invalid();
  }
  const token = (fields.token as string).trim();
  if (token.length > 1000 || /\s/u.test(token)) throw invalid();
  if (connection.id === "canvas") {
    const instanceUrl = (fields.instanceUrl as string).trim();
    if (instanceUrl.length > 500) throw invalid();
    let url: URL;
    try { url = new URL(instanceUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw invalid();
  }
}
