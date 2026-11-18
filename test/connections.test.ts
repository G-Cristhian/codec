import { describe, expect, it } from "vitest";
import { CONNECTIONS, projectConnections, validateConnectionInput } from "../src/connections.js";
import { CodecError } from "../src/errors.js";
import { S } from "../src/strings.js";

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
