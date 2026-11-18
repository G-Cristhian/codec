import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { request } from "node:http";
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { THEME_KEY } from "../src/ui.js";
import { cleanupTemps, tempDir, useIsolatedHome } from "./helpers.js";

function call(
  d: Dashboard,
  path: string,
  cookie = true,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(
      {
        // Large asset assertions can outlast an idle keep-alive socket under suite load.
        agent: false,
        host: "127.0.0.1",
        port: d.port,
        path,
        headers: {
          ...(cookie ? { Cookie: `codec_token_${d.port}=${d.token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("React foundation bundle", () => {
  let bundleDir: string;
  let d: Dashboard;
  beforeAll(async () => {
    bundleDir = tempDir("codec-ui-build-");
    const { build } = await import("vite");
    // Build the real UI in isolation. npm test also works in a fresh checkout
    // without dist/, and no running dashboard token is an input to this build.
    await build({
      configFile: join(import.meta.dirname, "../ui/vite.config.ts"),
      build: { outDir: bundleDir },
      logLevel: "silent",
    });
    writeFileSync(join(bundleDir, "assets", "plain.css"), "body{}");
    writeFileSync(
      join(bundleDir, "assets", "image-abcdefgh.png"),
      Buffer.from([137, 80, 78, 71, 0, 255]),
    );
  }, 60_000);
  beforeEach(async () => {
    useIsolatedHome("echo unused");
    d = await startDashboard({ port: 0, uiBundleDir: bundleDir });
  });
  afterEach(async () => {
    await d.close();
  });
  afterAll(() => cleanupTemps());

  it("serves React at / and its /next aliases, injecting the token only at serve time", async () => {
    const disk = readFileSync(join(bundleDir, "index.html"), "utf8");
    expect(disk).toContain('content="__CODEC_TOKEN__"');
    for (const file of [
      join(bundleDir, "index.html"),
      ...readdirSync(join(bundleDir, "assets")).map((f) =>
        join(bundleDir, "assets", f),
      ),
    ]) {
      expect(readFileSync(file).includes(Buffer.from(d.token))).toBe(false);
    }
    for (const path of ["/", "/next", "/next/"]) {
      const page = await call(d, path);
      expect(page.status).toBe(200);
      expect(page.body.toString()).toContain(`content="${d.token}"`);
      expect(page.body.toString()).not.toContain("__CODEC_TOKEN__");
      expect(page.headers["cache-control"]).toBe("no-store");
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(page.headers["content-security-policy"]).toContain(
        "script-src 'self' 'sha256-",
      );
      expect(
        String(page.headers["content-security-policy"]).split("style-src")[0],
      ).not.toContain("unsafe-inline");
    }
  });

  it("HTML-escapes all attribute delimiters in the injected token", async () => {
    await d.close();
    d = await startDashboard({
      port: 0,
      uiBundleDir: bundleDir,
      token: `x<&>"'$&`,
    });
    const page = await call(d, "/next");
    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain(
      'content="x&lt;&amp;&gt;&quot;&#39;$&amp;"',
    );
    expect(readFileSync(join(bundleDir, "index.html"), "utf8")).toContain(
      "__CODEC_TOKEN__",
    );
  });

  it("requires the cookie on pages/assets and preserves token-link redirects", async () => {
    const index = readFileSync(join(bundleDir, "index.html"), "utf8");
    const js = /src="\.\/assets\/([^"]+\.js)"/.exec(index)![1];
    for (const path of [
      "/next",
      "/next/",
      `/assets/${js}`,
      `/next/assets/${js}`,
    ]) {
      const locked = await call(d, path, false, { "x-codec-token": d.token });
      expect(locked.status).toBe(401);
      expect(locked.body.toString()).toContain("<title>");
      expect(locked.body.toString()).not.toContain(d.token);
      expect(locked.headers["cache-control"]).toBe("no-store");
    }
    expect((await call(d, "/next?token=wrong", false)).status).toBe(401);
    for (const path of ["/", "/next", "/next/"]) {
      const redirect = await call(d, `${path}?token=${d.token}`, false);
      expect(redirect.status).toBe(303);
      expect(redirect.headers.location).toBe(path);
      expect(String(redirect.headers["set-cookie"])).toContain(
        `codec_token_${d.port}=${d.token}; HttpOnly; SameSite=Strict; Path=/`,
      );
    }
  });

  it("serves JS/CSS and binary files with content types and private cache headers", async () => {
    const index = readFileSync(join(bundleDir, "index.html"), "utf8");
    for (const [, name] of index.matchAll(
      /(?:src|href)="\.\/assets\/([^"]+)"/g,
    )) {
      for (const prefix of ["/assets/", "/next/assets/"]) {
        const asset = await call(d, prefix + name);
        expect(asset.status).toBe(200);
        expect(asset.body).toEqual(
          readFileSync(join(bundleDir, "assets", name)),
        );
        expect(asset.headers["content-type"]).toBe(
          name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        );
        expect(asset.headers["cache-control"]).toBe(
          "private, max-age=31536000, immutable",
        );
        expect(asset.headers["x-content-type-options"]).toBe("nosniff");
      }
    }
    expect((await call(d, "/assets/plain.css")).headers["cache-control"]).toBe(
      "private, no-cache",
    );
    expect((await call(d, "/assets/image-abcdefgh.png")).body).toEqual(
      Buffer.from([137, 80, 78, 71, 0, 255]),
    );
  });

  it("refuses traversal, malformed paths, directories, symlink escapes, and non-assets", async () => {
    writeFileSync(join(bundleDir, "outside.js"), "private file");
    symlinkSync(
      join(bundleDir, "outside.js"),
      join(bundleDir, "assets", "escape.js"),
    );
    for (const path of [
      "/assets/../outside.js",
      "/assets/../../package.json",
      "/assets/%2e%2e/outside.js",
      "/next/assets/..%2foutside.js",
      "/assets/%252e%252e/outside.js",
      "/assets/..%5coutside.js",
      "/assets/%00.js",
      "/assets/%ZZ.js",
      "/assets/",
      "/assets/escape.js",
      "/assets/missing.js",
      "/assets/../",
      "/next/assets/../../",
      "/assets/../index.html",
      "/assets/index.html",
      "/next/index.html",
    ]) {
      const result = await call(d, path);
      expect(result.status, path).toBe(404);
      expect(result.body.toString()).not.toContain("private file");
      expect(result.body.toString()).not.toContain(d.token);
    }
  });

  it("explains a missing bundle at both root and alias", async () => {
    await d.close();
    d = await startDashboard({
      port: 0,
      uiBundleDir: join(bundleDir, "not-built"),
    });
    expect((await call(d, "/next", false)).status).toBe(401);
    const missing = await call(d, "/next");
    expect(missing.status).toBe(503);
    expect(missing.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(missing.body.toString()).toContain("npm run build");
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect((await call(d, "/")).status).toBe(503);
  });

  it("runs the no-flash script before CSS using the existing theme storage contract", () => {
    const html = readFileSync(join(bundleDir, "index.html"), "utf8");
    const boot = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(boot).toContain(
      `localStorage.getItem(${JSON.stringify(THEME_KEY)})`,
    );
    expect(html.indexOf("<script>")).toBeLessThan(
      html.indexOf('rel="stylesheet"'),
    );
    expect(
      readFileSync(join(import.meta.dirname, "../ui/src/lib/theme.ts"), "utf8"),
    ).toContain(`THEME_KEY = ${JSON.stringify(THEME_KEY)}`);
    const run = (stored: string | null, blocked = false) => {
      let theme: string | undefined;
      new Function("document", "localStorage", boot)(
        {
          documentElement: {
            setAttribute: (_: string, value: string) => {
              theme = value;
            },
            removeAttribute: () => {
              theme = undefined;
            },
          },
        },
        {
          getItem: () => {
            if (blocked) throw Error("blocked");
            return stored;
          },
        },
      );
      return theme;
    };
    expect(run("light")).toBe("light");
    expect(run("dark")).toBe("dark");
    expect(run("auto")).toBeUndefined();
    expect(run(null)).toBe("light");
    expect(run("invalid")).toBe("light");
    expect(run(null, true)).toBe("light");
    const css = readdirSync(join(bundleDir, "assets"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(bundleDir, "assets", f), "utf8"))
      .join("");
    expect(css).toContain(":where([data-theme=dark],[data-theme=dark] *)");
    expect(css).toContain(":root:not([data-theme])");
    expect(css).toContain("prefers-color-scheme:dark");
  });
});
