import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodecError } from "./errors.js";

// POSIX shell arguments may contain quotes, dollar signs, backticks and spaces.
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function installLauncher(root: string, home = homedir()): string {
  if (process.platform === "darwin") {
    const bundle = join(home, "Applications", "Codec.app");
    const contents = join(bundle, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Codec</string>
  <key>CFBundleDisplayName</key><string>Codec</string>
  <key>CFBundleIdentifier</key><string>com.codec.desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Codec</string>
  <key>CFBundleIconFile</key><string>codec.icns</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
    copyFileSync(join(root, "assets", "codec.icns"), join(contents, "Resources", "codec.icns"));
    const executable = join(contents, "MacOS", "Codec");
    writeFileSync(executable, `#!/bin/bash
# Finder does not load your terminal's PATH. Include the Node used to install
# Codec, both Homebrew locations, and common Claude/Codex installation paths.
export PATH=${shellQuote(dirname(process.execPath))}:"/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
  fi
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display alert "Codec needs Node.js" message "Install Node.js 22.12 or newer, then run npm install and npm run install-launcher in the Codec folder."'
  exit 1
fi
export CODEC_HOME="$HOME/.codec"
cd ${shellQuote(root)} || exit 1
exec npm run app
`, { mode: 0o755 });
    chmodSync(executable, 0o755); // Also repair an existing non-executable launcher.
    return bundle;
  }
  if (process.platform !== "linux") throw new CodecError("unsupported_platform", "Desktop launchers currently support macOS and Linux.");
  const destination = join(home, ".local", "share", "applications", "codec.desktop");
  // Desktop Exec uses its own quoting rules, not shell quoting. Escape % field codes.
  const quote = (value: string) => `"${value.replace(/[%]/g, "%%").replace(/[\\"`$]/g, "\\$&")}"`;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `[Desktop Entry]
Type=Application
Name=Codec
Comment=Work with your coding helpers
Icon=${join(root, "assets/codec.png")}
Exec=/usr/bin/env CODEC_HOME=/home/cristhian/projects/codec-home ${quote(process.execPath)} ${quote(join(root, "scripts/run-app.mjs"))}
Terminal=false
Categories=Development;
StartupWMClass=codec
`, { mode: 0o644 });
  return destination;
}
