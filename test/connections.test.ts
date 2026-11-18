import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { CONNECTIONS, connectionSecret, projectConnections, revokeConnection, saveConnection, setGitHubFetchForTests, validateConnectionInput } from "../src/connections.js";
import { CodecError } from "../src/errors.js";
import { S } from "../src/strings.js";
import { keychainUnavailable, setKeychainForTests } from "../src/keychain.js";
import { readEvents } from "../src/events.js";
import { getProject, removeProject } from "../src/registry.js";
import * as store from "../src/store.js";
import { cleanupTemps, fakeKeychain, useIsolatedHome } from "./helpers.js";

let home: string;
beforeEach(() => { home = useIsolatedHome("true"); });
afterEach(() => { vi.restoreAllMocks(); cleanupTemps(); });

describe("connections", () => {
  it("lists the fixed registry as disconnected for every project", () => {
    expect(CONNECTIONS).toEqual([{ id: "github", fields: ["token"] }, { id: "canvas", fields: ["instanceUrl", "token"] }]);
    expect(projectConnections("anything")).toEqual([{ id: "github", connected: false }, { id: "canvas", connected: false }]);
  });

  it.each([
    ["github", { token: "test-token" }],
    ["github", { token: "  test-token  " }],
    ["github", { token: "t".repeat(1000) }],
    ["canvas", { token: "test-token", instanceUrl: "https://school.instructure.com" }],
    ["canvas", { token: "test-token", instanceUrl: " https://school.instructure.com/ " }],
    ["canvas", { token: "test-token", instanceUrl: "https://school.example/" + "a".repeat(477) }],
  ])("accepts valid %s input %#", (id, body) => {
    expect(() => validateConnectionInput(id, body)).not.toThrow();
  });

  it.each([
    ["github", { token: "" }],
    ["github", { token: " \t\n " }],
    ["github", { token: "private token" }],
    ["github", { token: "private\ntoken" }],
    ["github", { token: "private\ttoken" }],
    ["github", { token: "private\0token" }],
    ["github", { token: "t".repeat(1001) }],
    ["github", { token: 123 }],
    ["github", {}],
    ["github", null],
    ["github", []],
    ["canvas", { token: "private-token", instanceUrl: "http://school.example" }],
    ["canvas", { token: "private-token", instanceUrl: "https://user:password@school.example" }],
    ["canvas", { token: "private-token", instanceUrl: "https://user@school.example" }],
    ["canvas", { token: "private-token", instanceUrl: "not-a-url" }],
    ["canvas", { token: "private-token", instanceUrl: "https://" }],
    ["canvas", { token: "private-token", instanceUrl: " " }],
    ["canvas", { token: "private-token", instanceUrl: 123 }],
    ["canvas", { token: "private-token" }],
    ["canvas", { token: "private-token", instanceUrl: "https://school.example/" + "a".repeat(479) }],
  ])("rejects invalid %s input without exposing credentials %#", (id, body) => {
    let caught: unknown;
    try { validateConnectionInput(id, body); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodecError);
    expect(caught).toMatchObject({ code: "invalid_connection", status: 400, message: S.errors.invalid_connection, params: {} });
    if (body && "token" in body && typeof body.token === "string" && body.token.trim()) {
      expect(String(caught)).not.toContain(body.token);
      expect(JSON.stringify(caught)).not.toContain(body.token);
    }
  });

  it("checks unknown ids before input and never echoes them", () => {
    expect(() => validateConnectionInput("private-token", { token: "private-token" }))
      .toThrow(expect.objectContaining({ code: "connection_not_found", status: 404, message: S.errors.connection_not_found, params: {} }));
  });
});

describe("GitHub connection storage", () => {
  const token = "ghp_fakeTestOnlyNeverReal1234";
  let chain: ReturnType<typeof fakeKeychain>;
  let fetchGitHub: ReturnType<typeof vi.fn<typeof fetch>>;
  const metadata = () => JSON.parse(readFileSync(join(home, "connections.json"), "utf8"));
  const connect = (value = token) => saveConnection("project", "github", { token: value });
  function noSecretOnDisk(value = token) {
    for (const relative of readdirSync(home, { recursive: true })) {
      const file = join(home, String(relative));
      if (statSync(file).isFile()) expect(readFileSync(file, "utf8"), String(relative)).not.toContain(value);
    }
  }
  beforeEach(() => {
    store.writeJsonAtomic(store.projectsFile(), { projects: ["project", "other"].map((name) => ({
      name, path: join(home, name), addedAt: new Date().toISOString(),
    })) });
    chain = fakeKeychain();
    setKeychainForTests(chain);
    fetchGitHub = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ login: "octocat", ignored: token }), {
      status: 200, headers: { "X-OAuth-Scopes": "repo, read:user" },
    }));
    setGitHubFetchForTests(fetchGitHub);
  });

  it("checks GitHub, stores only metadata with mode 0600, and keeps the token only in the keychain", async () => {
    const result = await connect();
    expect(result).toEqual({ id: "github", connected: true, hint: "ghp_••••••1234", login: "octocat" });
    expect(chain.secrets).toEqual(new Map([["project/github", token]]));
    expect(metadata()).toEqual({ project: { github: {
      connectedAt: expect.any(String), hint: result.hint, login: "octocat", scopes: "repo, read:user",
    } } });
    expect(Number.isNaN(Date.parse(metadata().project.github.connectedAt))).toBe(false);
    expect(statSync(join(home, "connections.json")).mode & 0o777).toBe(0o600);
    expect(projectConnections("project")).toEqual([result, { id: "canvas", connected: false }]);
    expect(connectionSecret("project", "github")).toBe(token);
    expect(fetchGitHub).toHaveBeenCalledExactlyOnceWith("https://api.github.com/user", {
      method: "GET", redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "codec" },
    });
    expect(readEvents()).toEqual([{ ts: expect.any(String), kind: "connection.save", project: "project", id: "github", login: "octocat" }]);
    noSecretOnDisk();
  });

  it.each([["tiny", "••••••"], ["12345678901", "••••••"], ["123456789012", "1234••••••9012"]])("masks token %s", async (value, hint) => {
    expect((await connect(value)).hint).toBe(hint);
    noSecretOnDisk(value);
  });

  it("accepts fine-grained tokens without a scopes header or login", async () => {
    fetchGitHub.mockResolvedValueOnce(new Response("{}"));
    expect(await connect()).toEqual({ id: "github", connected: true, hint: "ghp_••••••1234" });
    expect(Object.keys(metadata().project.github).sort()).toEqual(["connectedAt", "hint"]);
  });

  it("replaces an existing connection and leaves other projects alone", async () => {
    await saveConnection("other", "github", { token: "other-test-token" });
    await connect();
    const next = "github_pat_fakeReplacement5678";
    await connect(`  ${next}  `);
    expect(chain.secrets.get("project/github")).toBe(next);
    expect(metadata().project.github.hint).toBe("gith••••••5678");
    expect(metadata().other.github).toBeDefined();
    expect(projectConnections("missing").every((entry) => !entry.connected)).toBe(true);
    noSecretOnDisk();
    noSecretOnDisk(next);
  });

  it.each([401, 403, 429, 500, 302])("handles GitHub status %i without storing anything", async (status) => {
    fetchGitHub.mockResolvedValueOnce(new Response(token, { status }));
    const code = status === 401 ? "invalid_github_token" : "github_unreachable";
    await expect(connect()).rejects.toMatchObject({ code, status: status === 401 ? 400 : 502, message: S.errors[code], params: {} });
    expect(chain.secrets.size).toBe(0);
    expect(readdirSync(home)).toEqual(["projects.json"]);
  });

  it.each(["network", "timeout", "bad JSON"])("sanitizes %s failures and stores nothing", async (kind) => {
    if (kind === "bad JSON") fetchGitHub.mockResolvedValueOnce(new Response(token));
    else fetchGitHub.mockRejectedValueOnce(new Error(token));
    await expect(connect()).rejects.toMatchObject({ code: "github_unreachable", status: 502, message: S.errors.github_unreachable });
    expect(chain.secrets.size).toBe(0);
    expect(readdirSync(home)).toEqual(["projects.json"]);
  });

  it("uses a ten-second timeout signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await connect();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("validates before touching the keychain or GitHub", async () => {
    const available = vi.spyOn(chain, "available");
    await expect(connect(" ")).rejects.toMatchObject({ code: "invalid_connection" });
    expect(available).not.toHaveBeenCalled();
    expect(fetchGitHub).not.toHaveBeenCalled();
  });

  it("rejects an unavailable keychain before calling GitHub", async () => {
    chain.available = () => false;
    await expect(connect()).rejects.toMatchObject({ code: "keychain_unavailable", status: 409 });
    expect(fetchGitHub).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual(["projects.json"]);
  });

  it("does not write metadata when keychain.set fails", async () => {
    chain.set = () => { throw keychainUnavailable(); };
    await expect(connect()).rejects.toMatchObject({ code: "keychain_unavailable", status: 409 });
    expect(projectConnections("project")[0].connected).toBe(false);
    noSecretOnDisk();
  });

  it("rolls back the keychain if the atomic metadata write fails", async () => {
    const remove = vi.spyOn(chain, "delete");
    vi.spyOn(store, "writeJsonAtomic").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(connect()).rejects.toThrow("disk unavailable");
    expect(remove).toHaveBeenCalledWith("project/github");
    expect(chain.secrets.size).toBe(0);
    expect(projectConnections("project")[0].connected).toBe(false);
    expect(readEvents()).toEqual([]);
    noSecretOnDisk();
  });

  it("revokes the keychain entry and metadata and logs only the identity", async () => {
    await connect();
    const remove = vi.spyOn(chain, "delete").mockImplementation((account) => {
      expect(metadata().project.github).toBeDefined();
      chain.secrets.delete(account);
    });
    expect(revokeConnection("project", "github")).toEqual({ id: "github", connected: false });
    expect(remove).toHaveBeenCalledExactlyOnceWith("project/github");
    expect(metadata()).toEqual({});
    expect(connectionSecret("project", "github")).toBeUndefined();
    expect(readEvents().at(-1)).toEqual({ ts: expect.any(String), kind: "connection.revoke", project: "project", id: "github", login: "octocat" });
    noSecretOnDisk();
  });

  it("returns 404 when revoking a disconnected project without touching the keychain", () => {
    const remove = vi.spyOn(chain, "delete");
    expect(() => revokeConnection("project", "github")).toThrow(expect.objectContaining({ code: "connection_not_found", status: 404 }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps metadata when keychain deletion fails", async () => {
    await connect();
    const before = metadata();
    chain.delete = () => { throw keychainUnavailable(); };
    expect(() => revokeConnection("project", "github")).toThrow(expect.objectContaining({ code: "keychain_unavailable", status: 409 }));
    expect(metadata()).toEqual(before);
    expect(chain.secrets.get("project/github")).toBe(token);
    expect(readEvents()).toHaveLength(1);
  });

  it.each([false, true])("project removal drops metadata and tolerates keychain failure: %s", async (fails) => {
    await connect();
    if (fails) chain.delete = () => { throw new Error("private output " + token); };
    expect(removeProject("project").name).toBe("project");
    expect(getProject("project")).toBeUndefined();
    expect(metadata()).toEqual({});
    if (fails) expect(readEvents()).toContainEqual({ ts: expect.any(String), kind: "connection.cleanup_failed", project: "project", id: "github" });
    else expect(chain.secrets.size).toBe(0);
    noSecretOnDisk();
  });

  it("does not save a connection when the project was removed while GitHub was checking", async () => {
    let checked!: (response: Response) => void;
    fetchGitHub.mockImplementationOnce(() => new Promise((resolve) => { checked = resolve; }));
    const pending = connect();
    removeProject("project");
    checked(new Response(JSON.stringify({ login: "octocat" })));
    await expect(pending).rejects.toMatchObject({ code: "project_not_found", status: 404 });
    expect(chain.secrets.size).toBe(0);
    expect(projectConnections("project")[0].connected).toBe(false);
    expect(readEvents().some((event) => event.kind === "connection.save")).toBe(false);
    noSecretOnDisk();
  });

  it("keeps Canvas unavailable", async () => {
    await expect(saveConnection("project", "canvas", { token, instanceUrl: "https://school.example" })).rejects.toMatchObject({ code: "connections_unavailable", status: 409 });
    expect(() => revokeConnection("project", "canvas")).toThrow(expect.objectContaining({ code: "connections_unavailable", status: 409 }));
    expect(fetchGitHub).not.toHaveBeenCalled();
    expect(chain.secrets.size).toBe(0);
  });
});
