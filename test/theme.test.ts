import { describe, expect, it } from "vitest";
import { renderLocked, renderPage, THEME_KEY } from "../src/ui.js";

const page = renderPage("tok");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

describe("theme switch", () => {
  it("applies a saved choice in <head> before any styles or body", () => {
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head.indexOf("<script>")).toBeGreaterThan(-1);
    expect(head.indexOf("<script>")).toBeLessThan(head.indexOf("<style>"));
    expect(scripts[0]).toContain(`localStorage.getItem(${JSON.stringify(THEME_KEY)})`);
    expect(scripts[0]).toContain('setAttribute("data-theme",t)');
  });

  it("boot script sets data-theme only for light/dark, and survives blocked storage", () => {
    const run = (stored: string | null, throws = false) => {
      const attrs: Record<string, string> = {};
      const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
      const localStorage = {
        getItem: () => {
          if (throws) throw new Error("blocked");
          return stored;
        },
      };
      new Function("document", "localStorage", scripts[0])(document, localStorage);
      return attrs["data-theme"];
    };
    expect(run("dark")).toBe("dark");
    expect(run("light")).toBe("light");
    expect(run(null)).toBeUndefined();
    expect(run("purple")).toBeUndefined();
    expect(run(null, true)).toBeUndefined();
  });

  it("offers Auto / Light / Dark in the header, Auto first (default)", () => {
    const header = page.slice(page.indexOf("<header>"), page.indexOf("</header>"));
    const opts = [...header.matchAll(/<option value="(\w+)">(\w+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(opts).toEqual([["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]);
  });

  it("dark palette applies when chosen or on auto+OS dark; light wins when chosen", () => {
    const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
    expect(css).toMatch(/:root \{\s*color-scheme: light;/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{\s*color-scheme: dark;[^}]*--bg: #0f1115/);
    // OS-dark only applies with no explicit choice, so [data-theme=light] keeps the light vars.
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{\s*color-scheme: dark;[^}]*--bg: #0f1115/,
    );
    expect(css).not.toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
  });

  it("all inline scripts parse (no template-literal breakage)", () => {
    expect(scripts.length).toBe(2);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(scripts[1]).toContain(JSON.stringify(THEME_KEY));
  });

  it("locked page follows the OS theme", () => {
    const html = renderLocked();
    expect(html).toContain("color-scheme:light");
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)\{:root\{color-scheme:dark;/);
    expect(html).toContain("background:var(--bg)");
  });
});
