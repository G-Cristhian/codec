import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { installLauncher } from "../src/launcher.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
const temporary: string[] = [];
const root = fileURLToPath(new URL("..", import.meta.url));
function home() {
  const path = mkdtempSync(join(tmpdir(), "codec-launcher-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "execPath", executable);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("installs a macOS app bundle, icon and executable with the Mac data home", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const user = home();
  const bundle = installLauncher(root, user);
  expect(bundle).toBe(join(user, "Applications", "Codec.app"));
  const contents = join(bundle, "Contents");
  const plist = readFileSync(join(contents, "Info.plist"), "utf8");
  expect(plist).toContain('<key>CFBundleExecutable</key><string>Codec</string>');
  expect(plist).toContain('<key>CFBundlePackageType</key><string>APPL</string>');
  expect(plist).toContain('<key>CFBundleIconFile</key><string>codec.icns</string>');
  expect(readFileSync(join(contents, "Resources", "codec.icns"))).toEqual(readFileSync(join(root, "assets", "codec.icns")));
  const script = join(contents, "MacOS", "Codec");
  const text = readFileSync(script, "utf8");
  expect(text).toContain('export CODEC_HOME="$HOME/.codec"');
  expect(text).toContain('/opt/homebrew/bin:/usr/local/bin:');
  expect(text).toContain('$NVM_DIR/nvm.sh');
  expect(text).toContain('exec npm run app');
  expect(text).not.toContain('/home/cristhian/projects/codec-home');
  expect(statSync(script).mode & 0o777).toBe(0o755);
  chmodSync(script, 0o644);
  installLauncher(root, user);
  expect(statSync(script).mode & 0o777).toBe(0o755);
  expect(existsSync(join(user, ".codec"))).toBe(false);
  execFileSync("/bin/bash", ["-n", script]);
});

it("runs the Mac launcher from a minimal Finder PATH, quoting unusual checkout paths", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const user = home();
  const checkout = join(user, "Codec's $checkout `literal` space");
  mkdirSync(checkout);
  // Reuse assets while pointing the launcher's cd at the unusual checkout.
  mkdirSync(join(checkout, "assets"));
  writeFileSync(join(checkout, "assets", "codec.icns"), readFileSync(join(root, "assets", "codec.icns")));
  const bin = join(user, "node-bin");
  mkdirSync(bin);
  Object.defineProperty(process, "execPath", { value: join(bin, "node") });
  writeFileSync(join(bin, "node"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$CODEC_HOME" "$*" "$PATH"\n', { mode: 0o755 });
  const bundle = installLauncher(checkout, user);
  const output = execFileSync(join(bundle, "Contents", "MacOS", "Codec"), [], {
    env: { HOME: user, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CODEC_HOME: "/wrong/linux/home" }, encoding: "utf8",
  }).trim().split("\n");
  expect(output.slice(0, 3)).toEqual([checkout, join(user, ".codec"), "run app"]);
  expect(output[3]).toContain('/opt/homebrew/bin:/usr/local/bin:');
  expect(dirname(process.execPath)).toBe(bin);
});

it("keeps the Linux desktop entry and owner's Linux data home", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const user = home();
  const destination = installLauncher(root, user);
  expect(destination).toBe(join(user, ".local", "share", "applications", "codec.desktop"));
  const text = readFileSync(destination, "utf8");
  expect(text).toContain('Exec=/usr/bin/env CODEC_HOME=/home/cristhian/projects/codec-home');
  expect(text).toContain(`Icon=${join(root, "assets/codec.png")}`);
  expect(text).toContain(`"${join(root, "scripts/run-app.mjs")}"`);
  expect(text).toContain('StartupWMClass=codec');
  expect(statSync(destination).mode & 0o777).toBe(0o644);
});

it("falls back to nvm when Finder cannot find Node/npm", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const user = home();
  Object.defineProperty(process, "execPath", { value: join(user, "removed-node", "node") });
  const bin = join(user, "nvm-node-bin");
  mkdirSync(bin);
  mkdirSync(join(user, ".nvm"));
  writeFileSync(join(bin, "node"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$CODEC_HOME" "$*"\n', { mode: 0o755 });
  writeFileSync(join(user, ".nvm", "nvm.sh"), `
nvm() {
  printf '%s\\n' "$*" >> "$HOME/nvm-calls"
  if [ "$*" = "use --silent default" ]; then return 1; fi
  export PATH="$HOME/nvm-node-bin:$PATH"
}
`);
  const bundle = installLauncher(root, user);
  const output = execFileSync(join(bundle, "Contents", "MacOS", "Codec"), [], {
    env: { HOME: user, PATH: "/nonexistent" }, encoding: "utf8",
  }).trim().split("\n");
  expect(output).toEqual([join(user, ".codec"), "run app"]);
  expect(readFileSync(join(user, "nvm-calls"), "utf8")).toBe("use --silent default\nuse --silent node\n");
});
