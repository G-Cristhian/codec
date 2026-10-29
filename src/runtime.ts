/** Electron's execPath is a GUI executable; detached helpers need regular Node. */
export function helperNodeExecutable(
  electron = process.versions.electron,
  desktopNode = process.env.CODEC_DESKTOP_NODE,
  executable = process.execPath,
): string {
  return electron ? desktopNode || "node" : executable;
}
