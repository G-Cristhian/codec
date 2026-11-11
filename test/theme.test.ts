// @vitest-environment jsdom
import { createElement } from "react";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_BOOT, THEME_KEY, renderLocked } from "../src/ui.js";
import { useTheme } from "../ui/src/lib/theme";
import { S } from "../src/strings.js";
const html = readFileSync(
  join(import.meta.dirname, "../ui/index.html"),
  "utf8",
);
const css = readFileSync(
  join(import.meta.dirname, "../ui/src/index.css"),
  "utf8",
);
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-sidebar");
});
function Switch() {
  const [theme, set] = useTheme();
  return createElement(
    "div",
    {},
    theme,
    ...(["auto", "light", "dark"] as const).map((t) =>
      createElement("button", { key: t, onClick: () => set(t) }, S.theme[t]),
    ),
  );
}
describe("theme contract", () => {
  it("uses the exact existing boot before all CSS and JS", () => {
    expect(html).toContain(THEME_BOOT);
    expect(html.indexOf(THEME_BOOT)).toBeLessThan(html.indexOf("<body>"));
    expect(THEME_KEY).toBe("codec-theme");
  });
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    [null, null],
    ["invalid", null],
  ])("boots saved %s as %s", (value, expected) => {
    localStorage.clear();
    if (value) localStorage.setItem(THEME_KEY, value);
    new Function(THEME_BOOT.slice(8, -9))();
    expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
  });
  it("restores the owner's collapsed sidebar before the first paint", () => {
    localStorage.setItem("codec-sidebar", "collapsed");
    new Function(THEME_BOOT.slice(8, -9))();
    expect(document.documentElement.getAttribute("data-sidebar")).toBe(
      "collapsed",
    );
    expect(css).toContain("--radius: 6px;");
  });
  it("survives storage being blocked", () => {
    expect(() =>
      new Function("localStorage", THEME_BOOT.slice(8, -9))({
        getItem() {
          throw Error("blocked");
        },
      }),
    ).not.toThrow();
  });
  it("changes and persists light and dark, and removes the attribute/key for Auto", () => {
    render(createElement(Switch));
    for (const t of ["light", "dark", "auto"] as const) {
      fireEvent.click(screen.getByText(S.theme[t]));
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        t === "auto" ? null : t,
      );
      expect(localStorage.getItem(THEME_KEY)).toBe(t === "auto" ? null : t);
    }
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("defines the light and dark token blocks plus OS-dark Auto, and the block-form variant", () => {
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css.replace(/\s+/g, "")).toContain(
      "@media(prefers-color-scheme:dark){:root:not([data-theme])",
    );
    expect(css.replace(/\s+/g, "")).toContain(
      '&:where([data-theme="dark"],[data-theme="dark"]*){@slot;}',
    );
    expect(css.replace(/\s+/g, "")).toContain(
      "&:where(:root:not([data-theme]),:root:not([data-theme])*){@slot;}",
    );
    for (const color of [
      "#f6f7f9",
      "#0f1115",
      "#b45309",
      "#5b6474",
      "#e6e8ee",
      "#6d8dff",
      "#0b0d11",
    ])
      expect(css).toContain(color);
  });
  it("serves an OS-themed locked card without scripts, tokens or bundle", () => {
    const locked = renderLocked();
    expect(locked).toContain(S.locked.title);
    expect(locked).toContain("max-width:448px");
    expect(locked).toContain('aria-hidden="true"');
    expect(locked).toContain("prefers-color-scheme: dark");
    expect(locked).not.toContain("<script");
    expect(locked).not.toContain("codec-token");
    expect(locked).not.toContain("/assets/");
  });
});
