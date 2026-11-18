import { CodecError } from "./errors.js";
import { S } from "./strings.js";
import { join } from "path";
import { codecHome, readJson, withLock, writeJsonAtomic } from "./store.js";
import { keychain, keychainUnavailable } from "./keychain.js";
import { logEvent } from "./events.js";
import { getProject } from "./registry.js";

export const CONNECTIONS = [
  { id: "github", fields: ["token"] },
  { id: "canvas", fields: ["instanceUrl", "token"] },
] as const;
export type ConnectionId = typeof CONNECTIONS[number]["id"];
export type ConnectionField = typeof CONNECTIONS[number]["fields"][number];
export interface ProjectConnection { id: ConnectionId; connected: boolean; hint?: string; login?: string }
export interface ConnectionInput { token: string; instanceUrl?: string }

interface ConnectionMetadata { connectedAt: string; hint: string; login?: string; scopes?: string }
type Metadata = Record<string, { github?: ConnectionMetadata }>;
const connectionsFile = () => join(codecHome(), "connections.json");
const load = () => readJson<Metadata>(connectionsFile(), {});
const save = (metadata: Metadata) => writeJsonAtomic(connectionsFile(), metadata, 0o600);
const account = (project: string, id: string) => `${project}/${id}`;
let githubFetch: typeof fetch | undefined;
export function setGitHubFetchForTests(fn: typeof fetch | undefined): void { githubFetch = fn; }

export function requireConnection(id: string) {
  const connection = CONNECTIONS.find((entry) => entry.id === id);
  if (!connection) throw new CodecError("connection_not_found", S.errors.connection_not_found, {}, 404);
  return connection;
}

export function projectConnections(project: string): ProjectConnection[] {
  const metadata = load();
  return CONNECTIONS.map(({ id }) => {
    const entry = id === "github" && Object.hasOwn(metadata, project) ? metadata[project].github : undefined;
    return entry ? { id, connected: true, hint: entry.hint, ...(entry.login ? { login: entry.login } : {}) }
      : { id, connected: false };
  });
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
  if (token.length > 1000 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(token)) throw invalid();
  if (connection.id === "canvas") {
    const instanceUrl = (fields.instanceUrl as string).trim();
    if (instanceUrl.length > 500) throw invalid();
    let url: URL;
    try { url = new URL(instanceUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw invalid();
  }
}

function requireGitHub(id: string): asserts id is "github" {
  requireConnection(id);
  if (id !== "github") throw new CodecError("connections_unavailable", S.errors.connections_unavailable, {}, 409);
}

async function checkGitHub(token: string): Promise<Pick<ConnectionMetadata, "login" | "scopes">> {
  let response: Response;
  try {
    response = await (githubFetch ?? fetch)("https://api.github.com/user", {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "codec" },
    });
  } catch {
    throw new CodecError("github_unreachable", S.errors.github_unreachable, {}, 502);
  }
  if (response.status === 401) throw new CodecError("invalid_github_token", S.errors.invalid_github_token);
  if (response.status !== 200) throw new CodecError("github_unreachable", S.errors.github_unreachable, {}, 502);
  try {
    const user: unknown = await response.json();
    const login = user && typeof user === "object" && "login" in user && typeof user.login === "string" ? user.login : undefined;
    const scopes = response.headers.get("X-OAuth-Scopes");
    return { ...(login ? { login } : {}), ...(scopes !== null ? { scopes } : {}) };
  } catch {
    throw new CodecError("github_unreachable", S.errors.github_unreachable, {}, 502);
  }
}

export async function saveConnection(project: string, id: string, body: unknown): Promise<ProjectConnection> {
  validateConnectionInput(id, body);
  requireGitHub(id);
  const chain = keychain();
  if (!chain.available()) throw keychainUnavailable();
  const token = (body as ConnectionInput).token.trim();
  const identity = await checkGitHub(token);
  const entry: ConnectionMetadata = { connectedAt: new Date().toISOString(),
    hint: token.length < 12 ? "••••••" : `${token.slice(0, 4)}••••••${token.slice(-4)}`, ...identity };
  withLock("connections", () => {
    // Validation awaited the network; removal may have happened in the meantime.
    // Removal takes this same lock to clean up any save that gets here first.
    if (!getProject(project)) throw new CodecError("project_not_found", S.errors.project_not_found, {}, 404);
    const metadata = load();
    chain.set(account(project, id), token);
    try {
      // Define an own property even for names such as "__proto__".
      Object.defineProperty(metadata, project, { value: { github: entry }, enumerable: true, configurable: true, writable: true });
      save(metadata);
    } catch (error) {
      try { chain.delete(account(project, id)); }
      catch { logEvent("connection.cleanup_failed", { project, id }); }
      throw error;
    }
  });
  logEvent("connection.save", { project, id, ...(entry.login ? { login: entry.login } : {}) });
  return { id, connected: true, hint: entry.hint, ...(entry.login ? { login: entry.login } : {}) };
}

export function revokeConnection(project: string, id: string): ProjectConnection {
  requireGitHub(id);
  const entry = withLock("connections", () => {
    const metadata = load();
    const entry = Object.hasOwn(metadata, project) ? metadata[project].github : undefined;
    if (!entry) throw new CodecError("connection_not_found", S.errors.connection_not_found, {}, 404);
    keychain().delete(account(project, id));
    delete metadata[project];
    save(metadata);
    return entry;
  });
  logEvent("connection.revoke", { project, id, ...(entry.login ? { login: entry.login } : {}) });
  return { id, connected: false };
}

/** Removal must succeed even if the system keychain is locked or unavailable. */
export function removeProjectConnections(project: string): void {
  try {
    withLock("connections", () => {
      const metadata = load();
      if (!Object.hasOwn(metadata, project)) return;
      for (const { id } of CONNECTIONS) {
        if (!(id in metadata[project])) continue;
        try { keychain().delete(account(project, id)); }
        catch { logEvent("connection.cleanup_failed", { project, id }); }
      }
      delete metadata[project];
      save(metadata);
    });
  } catch { logEvent("connection.cleanup_failed", { project }); }
}

/** Reserved for part B. Reading never copies the secret to Codec's data folder. */
export function connectionSecret(project: string, id: string): string | undefined {
  requireGitHub(id);
  return keychain().get(account(project, id));
}
