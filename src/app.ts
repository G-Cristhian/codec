import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { runDesktop } from "./desktop.js";

app.setName("Codec");
if (process.platform === "linux") app.setDesktopName("codec.desktop");
// A memory-only session keeps authentication cookies out of the disk profile.
void runDesktop({ app, BrowserWindow, Menu, shell, dialog }, fileURLToPath(new URL("../assets/codec.png", import.meta.url)));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
