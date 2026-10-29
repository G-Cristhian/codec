import { redactSecrets } from "./secrets.js";
import { accountLimitHit } from "./account-limits.js";

/** The detached wrapper keeps redacting and detecting limits after the dashboard closes. */
export const ACTIVITY_SCRIPT = `
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const redactSecrets = ${redactSecrets.toString()};
const accountLimitHit = ${accountLimitHit.toString()};
const dir = process.env.CODEC_RUN_DIR;
const decoder = new StringDecoder("utf8");
let line = "", dropping = false, limited = false;
function detect(text) {
  if (!limited && accountLimitHit(text)) { writeFileSync(join(dir, "limit_hit"), "true\\n", { mode: 0o600 }); limited = true; }
}
function save(text) {
  detect(text);
  appendFileSync(join(dir, "output.log"), redactSecrets(text), { mode: 0o600 });
}
process.stdin.on("data", chunk => {
  const pieces = decoder.write(chunk).split("\\n");
  for (let i = 0; i < pieces.length; i++) {
    if (!dropping) line += pieces[i];
    detect(line);
    if (line.length > 256 * 1024) { save("[Long activity line omitted]\\n"); line = ""; dropping = true; }
    if (i < pieces.length - 1) { if (!dropping) save(line + "\\n"); line = ""; dropping = false; }
  }
});
process.stdin.on("end", () => { if (!dropping) save(line + decoder.end()); });
`;
