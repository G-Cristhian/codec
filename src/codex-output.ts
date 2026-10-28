/** Codex currently runs without --json; its session header names the actual model. */
export function modelFromCodexOutput(raw: string): string | undefined {
  // Stop before the task and helper activity, which may themselves mention a model.
  const header = raw.split(/^user\r?$/m, 1)[0].split("\n").slice(0, 40).join("\n");
  return /^model:[ \t]*([A-Za-z0-9][A-Za-z0-9._:/-]*)[ \t\r]*$/m.exec(header)?.[1];
}
