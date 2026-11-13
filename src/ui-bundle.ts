import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Resolves to dist/ui from both src/ (tsx) and dist/ (compiled server).
const UI_BUNDLE_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));

export function renderNextPage(token: string, bundleDir = UI_BUNDLE_DIR): string | undefined {
  let html: string;
  try { html = readFileSync(join(bundleDir, "index.html"), "utf8"); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  const escaped = token.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return html.replaceAll("__CODEC_TOKEN__", () => escaped);
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Match the RAW request path before URL normalizes dot segments. Support both
// /next and /next/ with Vite's relative base, and / when rollout is complete.
export function isUiAssetPath(rawPath: string): boolean {
  return /^\/(?:next\/)?assets(?:\/|%2f|$)/i.test(rawPath);
}

export function readUiAsset(rawPath: string, bundleDir = UI_BUNDLE_DIR) {
  let path: string;
  try { path = decodeURIComponent(rawPath); } catch { return undefined; }
  const assetPath = path.replace(/^\/(?:next\/)?assets\//, "");
  if (assetPath === path || assetPath.split("/").some((p) => !p || p === "." || p === "..") || /[\\\0%]/.test(assetPath)) return undefined;
  const type = CONTENT_TYPES[extname(assetPath)];
  if (!type) return undefined;
  try {
    const root = realpathSync(join(bundleDir, "assets"));
    const file = realpathSync(join(root, assetPath));
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel) || !statSync(file).isFile()) return undefined;
    return {
      body: readFileSync(file),
      type,
      // Vite's default asset naming: [name]-[hash].[ext]. Unhashed files are
      // revalidated; private prevents shared caches from retaining this UI.
      cache: /-[\w-]{8,}\.[a-z0-9]+$/.test(assetPath) ? "private, max-age=31536000, immutable" : "private, no-cache",
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}
