/** Static unauthenticated page; authenticated screens live in ui/. */
import { S } from "./strings.js";
export const THEME_KEY = "codec-theme";
/** Light unless the owner picked Dark or Auto (follow the system). */
export const THEME_BOOT = `<script>var d=document.documentElement;d.setAttribute("data-theme","light");try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark")d.setAttribute("data-theme","dark");else if(t==="auto")d.removeAttribute("data-theme")}catch(e){}</script>`;
export function textHTML(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function renderLocked(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${S.checkpoints.fallbackName}</title><link rel="icon" href="data:,"/><style>
:root{color-scheme: light;
  --background: #f6f7f9;
  --foreground: #1b1f27;
  --card: #ffffff;
  --popover: #ffffff;
  --card-foreground: #1b1f27;
  --popover-foreground: #1b1f27;
  --muted: #eef0f4;
  --muted-foreground: #5b6474;
  --border: #dde1e8;
  --input: #dde1e8;
  --primary: #3b6cf6;
  --primary-foreground: #ffffff;
  --secondary: #eef0f4;
  --secondary-foreground: #1b1f27;
  --accent: #e8eefe;
  --accent-foreground: #1b1f27;
  --destructive: #c53030;
  --destructive-foreground: #ffffff;
  --ring: #3b6cf6;
  --status-working: #2f5be0;
  --status-working-soft: #e8eefe;
  --status-needs: #b45309;
  --status-needs-soft: #fdf1e3;
  --status-review: #6d28d9;
  --status-review-soft: #f1ebfe;
  --status-done: #15803d;
  --status-done-soft: #e6f6ec;
  --log-bg: #f3f4f6;
  --log-fg: #1b1f27;
  --radius: 6px;
}@media (prefers-color-scheme: dark){:root{color-scheme: dark;
  --background: #0f1115;
  --foreground: #e6e8ee;
  --card: #171a21;
  --popover: #171a21;
  --card-foreground: #e6e8ee;
  --popover-foreground: #e6e8ee;
  --muted: #1f232c;
  --muted-foreground: #9aa2b5;
  --border: #2a2f3a;
  --input: #2a2f3a;
  --primary: #6d8dff;
  --primary-foreground: #0f1115;
  --secondary: #1f232c;
  --secondary-foreground: #e6e8ee;
  --accent: #232a3d;
  --accent-foreground: #e6e8ee;
  --destructive: #f06a6a;
  --destructive-foreground: #0f1115;
  --ring: #6d8dff;
  --status-working: #6d8dff;
  --status-working-soft: #1d2540;
  --status-needs: #f0a050;
  --status-needs-soft: #352617;
  --status-review: #a78bfa;
  --status-review-soft: #2a2140;
  --status-done: #3ccf8e;
  --status-done-soft: #143024;
  --log-bg: #0b0d11;
  --log-fg: #d6dae3;
  --radius: 6px;
}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--background);color:var(--foreground);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}.card{width:100%;max-width:448px;padding:32px;text-align:center;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}.lock{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;margin:0 auto 16px;background:var(--muted)}.wordmark{font-size:18px;font-weight:600}h1{font-size:20px;font-weight:600;margin:16px 0 8px}p{color:var(--muted-foreground);margin:0}
</style></head><body><main class="card"><div class="lock"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg></div><div class="wordmark">${S.checkpoints.fallbackName}</div><h1>${textHTML(S.locked.title)}</h1><p>${textHTML(S.locked.hint)}</p></main></body></html>`;
}
