import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDependencies, installIsCurrent, recordInstall } from "../scripts/ensure-dependencies.mjs";
import { cleanupTemps, tempDir } from "./helpers.js";

function fixture() {
  const root = tempDir("codec-deps-");
  mkdirSync(join(root, "node_modules", "example"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { example: "1.0.0" } }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }));
  writeFileSync(join(root, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/example": { version: "1.0.0" } } }));
  writeFileSync(join(root, "node_modules", "example", "package.json"), '{"version":"1.0.0"}');
  return root;
}

afterEach(cleanupTemps);
describe("pull-and-build dependency check", () => {
  it("installs once when no stamp exists and skips an unchanged install", () => {
    const root = fixture();
    let installs = 0;
    ensureDependencies(root, () => { installs++; });
    expect(installs).toBe(1);
    expect(installIsCurrent(root)).toBe(true);
    ensureDependencies(root, () => { installs++; });
    expect(installs).toBe(1);
    writeFileSync(join(root, "package-lock.json"), '{"packages":{"node_modules/example":{"version":"2.0.0"}}}');
    expect(installIsCurrent(root)).toBe(false);
    // Even npm install --package-lock-only (which runs postinstall) cannot
    // incorrectly mark an older installed dependency tree as current.
    recordInstall(root);
    expect(installIsCurrent(root)).toBe(false);
  });

  it("detects a missing direct package or changed manifest", () => {
    const root = fixture();
    recordInstall(root);
    writeFileSync(join(root, "package.json"), '{"devDependencies":{"missing":"1.0.0"}}');
    expect(installIsCurrent(root)).toBe(false);
    recordInstall(root);
    expect(installIsCurrent(root)).toBe(false);
  });

  it("stops a build when installation fails", () => {
    const root = fixture();
    expect(() => ensureDependencies(root, () => { throw Error("install failed"); })).toThrow("install failed");
    expect(installIsCurrent(root)).toBe(false);
  });

  it("accepts omitted platform-specific packages but detects missing required transitive packages", () => {
    const root = fixture();
    const packages = {
      "node_modules/example": { version: "1.0.0" },
      "node_modules/other-platform": { version: "1.0.0", optional: true },
    };
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages }));
    recordInstall(root);
    expect(installIsCurrent(root)).toBe(true);
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      ...packages, "node_modules/required-transitive": { version: "1.0.0" },
    } }));
    recordInstall(root);
    expect(installIsCurrent(root)).toBe(false);
  });
});
