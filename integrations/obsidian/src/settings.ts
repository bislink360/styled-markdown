/** The plugin's settings (stored in `.obsidian/plugins/styled-markdown/data.json`). Pure, so it is tested without Obsidian. */

export type AgentBlocks = 'collapsed' | 'expanded' | 'hidden';

export interface SmdSettings {
  /** Render `:::` containers in reading view. */
  containers: boolean;
  /** Render inline directives (`:badge[…]`, `:status[…]`, `:due[…]`…) and `[text]{attrs}` spans in reading view. */
  inlineDirectives: boolean;
  /** How `:::agent` blocks (written for AI agents) are shown. */
  agentBlocks: AgentBlocks;
  /** Open `.smd` files in Obsidian's Markdown view (takes effect when the plugin loads). */
  smdFiles: boolean;
}

export const DEFAULT_SETTINGS: Readonly<SmdSettings> = Object.freeze({
  containers: true,
  inlineDirectives: true,
  agentBlocks: 'collapsed',
  smdFiles: true,
});

export const AGENT_BLOCK_CHOICES: Readonly<Record<AgentBlocks, string>> = Object.freeze({
  collapsed: 'Collapsed',
  expanded: 'Expanded',
  hidden: 'Hidden',
});

/** Saved data (whatever `loadData()` returns) as complete settings: unknown keys dropped, bad values defaulted. */
export function normalizeSettings(data: unknown): SmdSettings {
  const saved = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const flag = (key: 'containers' | 'inlineDirectives' | 'smdFiles') =>
    typeof saved[key] === 'boolean' ? (saved[key] as boolean) : DEFAULT_SETTINGS[key];
  const agentBlocks = Object.hasOwn(AGENT_BLOCK_CHOICES, String(saved.agentBlocks)) ? (saved.agentBlocks as AgentBlocks) : DEFAULT_SETTINGS.agentBlocks;
  return { containers: flag('containers'), inlineDirectives: flag('inlineDirectives'), agentBlocks, smdFiles: flag('smdFiles') };
}
