import { fileURLToPath } from "node:url";
import { installLauncher } from "./launcher.js";

console.log(`Installed ${installLauncher(fileURLToPath(new URL("..", import.meta.url)))}`);
