export type AgentName = 'claude' | 'codex' | 'grok';

export function parseAgent(raw?: string): AgentName {
  const v = (raw || process.env.CTI_AGENT || 'codex').trim().toLowerCase();
  if (v === 'claude' || v === 'codex' || v === 'grok') return v;
  throw new Error(`Unknown CTI_AGENT="${raw}". Use claude, codex, or grok.`);
}
