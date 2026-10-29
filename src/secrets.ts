/** Shared at output boundaries, including the standalone task activity writer. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_|rt_|sess-)[A-Za-z0-9_\-]{12,})\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization|client[_-]?secret|code_verifier|password|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)["']?\s*[:=]\s*["']?)([^\s"',}&]+)/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_+-]{48,}={0,2}\b/g, (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9_+-]/.test(value) ? "[redacted]" : value);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return safeSignInUrl(value) ? value : redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization|client[_-]?secret|password)$/i.test(key) ? "[redacted]" : redactValue(item)]));
  return value;
}

/** Only authorization instructions, never credential-bearing callback/token addresses. */
export function safeSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    const pathOK = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)
      ? /^\/(?:cai\/)?oauth\/authorize$/.test(url.pathname)
      : url.hostname === "auth.openai.com" && ["/oauth/authorize", "/codex/device"].includes(url.pathname);
    if (!pathOK) return false;
    const keys = new Set(["code", "client_id", "response_type", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "login_hint", "organization_uuid", "prompt", "originator", "id_token_add_organizations", "codex_cli_simplified_flow", "screen_hint"]);
    return [...url.searchParams].every(([key, val]) => keys.has(key) && (key !== "code" || val === "true") && !/\b(?:sk-|eyJ)/.test(val));
  } catch { return false; }
}
