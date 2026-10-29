/** CLI error families researched in codec-private/c/RESEARCH.md. */
export function accountLimitHit(output: string): boolean {
  const text = output.replace(/[‘’]/g, "'").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /\b(?:(?:workspace_(?:owner|member)_)?usage_limit_(?:reached|exceeded)|workspace_(?:owner|member)_credits_depleted|rate_limit_(?:error|exceeded)|insufficient_quota)\b/i.test(text) ||
    /\byou(?:'ve| have) (?:hit|reached) your (?:[^\n.]{0,45} )?(?:usage |rate |weekly |session )?limit\b/i.test(text) ||
    /\b(?:you(?:'re| are)|your (?:org|workspace) is) out of (?:extra usage|usage(?: credits)?|credits)\b/i.test(text) ||
    /\b(?:rate limit (?:exceeded|reached)|quota exceeded|credit balance is too low|spend limit reached)\b/i.test(text) ||
    /\b(?:API Error|HTTP(?:\/\d(?:\.\d)?)?(?: error| status)?|status(?: code)?)\s*:?\s*429\b/i.test(text) ||
    /\byour usage allocation has been disabled|your group's usage limit is set to \$0/i.test(text);
}
