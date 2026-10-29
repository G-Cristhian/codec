import electron from "electron";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, CODEC_DESKTOP_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
// Desktop sessions may have a smaller PATH than the shell that installed Codec.
env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
let noSandbox = process.platform === "linux" && env.CODEC_NO_SANDBOX === "1";
if (process.platform === "linux" && env.CODEC_NO_SANDBOX === undefined) {
  try {
    const helper = statSync(join(dirname(electron), "chrome-sandbox"));
    const setuidHelper = helper.uid === 0 && (helper.mode & 0o4000) !== 0;
    const restricted = readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
    if (restricted && !setuidHelper) {
      noSandbox = spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore" }).status !== 0;
    }
  } catch { /* Otherwise keep Electron's sandbox defaults. */ }
}
if (noSandbox) console.error("Codec: using --no-sandbox for this launch (see README, Desktop app).");
const child = spawn(electron, [...(noSandbox ? ["--no-sandbox"] : []), ...(process.platform === "linux" ? ["--class=Codec"] : []), root], {
  cwd: root, env, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(`Codec could not start: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
