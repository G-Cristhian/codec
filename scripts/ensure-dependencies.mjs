import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stampPath = (root) => join(root, "node_modules", ".codec-install-hash");
const fingerprint = (root) => createHash("sha256")
  .update(readFileSync(join(root, "package.json")))
  .update(readFileSync(join(root, "package-lock.json")))
  .digest("hex");

export function recordInstall(root = repoRoot) {
  writeFileSync(stampPath(root), fingerprint(root));
}

export function installIsCurrent(root = repoRoot) {
  try {
    if (readFileSync(stampPath(root), "utf8") !== fingerprint(root)) return false;
    if (!existsSync(join(root, "node_modules", ".package-lock.json"))) return false;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const installedLock = JSON.parse(readFileSync(join(root, "node_modules", ".package-lock.json"), "utf8"));
    for (const [path, expected] of Object.entries(lock.packages)) {
      if (!path) continue;
      const installed = installedLock.packages[path];
      // npm omits optional dependencies for other OS/CPU combinations.
      if (!installed) { if (expected.optional) continue; return false; }
      for (const key of ["version", "resolved", "integrity", "link"]) {
        if (installed[key] !== expected[key]) return false;
      }
    }
    if (Object.keys(installedLock.packages).some((path) => !lock.packages[path])) return false;
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
      if (installed.version !== lock.packages[`node_modules/${name}`]?.version) return false;
    }
    return true;
  } catch { return false; }
}

export function ensureDependencies(root = repoRoot, install = () => {
  const npm = process.env.npm_execpath;
  const result = npm
    ? spawnSync(process.execPath, [npm, "install", "--include=dev"], { cwd: root, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--include=dev"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("npm install failed; build stopped.");
}) {
  if (installIsCurrent(root)) return;
  console.log("Codec: packages changed; running npm install before building.");
  install();
  recordInstall(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--record")) recordInstall();
  else ensureDependencies();
}
