/**
 * The Styled Markdown vocabulary. Everything the renderer, validator,
 * completion provider and converters know about lives here, so the format
 * has exactly one source of truth.
 */

export const SMD_VERSION = 1;

/** Named colors. They map to CSS variables that adapt to light/dark themes. */
export const NAMED_COLORS = [
  'red', 'orange', 'amber', 'yellow', 'green', 'teal', 'cyan',
  'blue', 'indigo', 'purple', 'pink', 'gray', 'muted', 'accent',
] as const;

export const DECISION_STATUS = ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'];
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WS', 'RPC', 'EVENT'];
export const PRIORITY_VALUES = ['P0', 'P1', 'P2', 'P3', 'P4', 'critical', 'high', 'medium', 'low'];

export const CALLOUT_TYPES = ['note', 'info', 'tip', 'success', 'warning', 'danger', 'question'] as const;

export interface ContainerSpec {
  description: string;
  /** Attribute keys accepted on the opening line, beyond the shared style keys. */
  attrs?: string[];
  /** Must be nested directly inside this container. */
  parent?: string;
  /** Title text after the name is meaningful. */
  title?: boolean;
  /** Allowed values for enumerated attributes. */
  values?: Record<string, string[]>;
  /** Attributes that must be present. */
  required?: string[];
}

const callout = (label: string): ContainerSpec => ({
  description: `${label} callout. Optional title after the name.`,
  title: true,
  attrs: ['title', 'collapsible'],
});

export const CONTAINERS: Record<string, ContainerSpec> = {
  note: callout('Neutral note'),
  info: callout('Informational'),
  tip: callout('Helpful tip'),
  success: callout('Success / done'),
  warning: callout('Warning'),
  danger: callout('Danger / breaking'),
  question: callout('Open question'),
  details: { description: 'Collapsible section. Title after the name is the summary.', title: true, attrs: ['title', 'open'] },
  card: { description: 'Bordered card with optional title and accent color.', title: true, attrs: ['title', 'accent'] },
  box: { description: 'Generic styled block — use style attributes (bg, color, border, align...).', title: false },
  tabs: { description: 'Tab group. Contains :::tab children (writing the outer fence as ::::tabs helps readability).' },
  tab: { description: 'One tab inside ::::tabs. Title after the name is the tab label.', parent: 'tabs', title: true, attrs: ['title'] },
  columns: { description: 'Side-by-side layout. Contains :::column children.' },
  column: { description: 'One column inside ::::columns.', parent: 'columns', attrs: ['width'] },
  steps: { description: 'Renders the ordered list inside as numbered, connected steps.' },
  agent: {
    description: 'Content addressed to AI agents (instructions, constraints, context). Collapsed for humans in the preview.',
    title: true,
    attrs: ['title', 'priority'],
  },
  human: { description: 'Content addressed only to human readers. Agents may skip it.', title: true, attrs: ['title'] },

  // Product / project management
  decision: {
    description: 'Decision record (ADR-style): what was decided, by whom, when. Title = the decision.',
    title: true,
    attrs: ['title', 'status', 'date', 'owner'],
    values: { status: DECISION_STATUS },
  },
  risk: {
    description: 'Risk with impact and likelihood. Body = description and mitigation.',
    title: true,
    attrs: ['title', 'impact', 'likelihood', 'owner', 'status'],
    values: { impact: RISK_LEVELS, likelihood: RISK_LEVELS, status: ['open', 'mitigated', 'accepted', 'closed'] },
  },
  timeline: { description: 'Renders the list inside as a vertical timeline (start items with a date).' },

  // Developer
  api: {
    description: 'API endpoint: method + path header, body documents parameters and responses.',
    title: true,
    attrs: ['title', 'method', 'path', 'auth'],
    values: { method: HTTP_METHODS },
    required: ['method', 'path'],
  },
};

/** Style keys accepted on any attribute list: [text]{...}, :::box{...}, etc. */
export const STYLE_KEYS: Record<string, string> = {
  color: 'Text color: a named color (red, blue…) or #hex / rgb()',
  bg: 'Background color: a named color or #hex / rgb()',
  border: 'Border color: a named color or #hex',
  size: 'Font size: xs | sm | md | lg | xl | 2xl',
  weight: 'Font weight: normal | medium | bold',
  font: 'Font family: sans | serif | mono',
  align: 'Text alignment (blocks): left | center | right',
  style: 'Text decoration: italic | underline | strike',
};

export const SIZE_VALUES: Record<string, string> = {
  xs: '0.75em', sm: '0.875em', md: '1em', lg: '1.25em', xl: '1.5em', '2xl': '2em',
};
export const WEIGHT_VALUES: Record<string, string> = { normal: '400', medium: '500', bold: '700' };
export const FONT_VALUES: Record<string, string> = {
  sans: 'var(--smd-font-sans)', serif: 'var(--smd-font-serif)', mono: 'var(--smd-font-mono)',
};
export const ALIGN_VALUES = ['left', 'center', 'right'];
export const TEXT_STYLE_VALUES: Record<string, string> = {
  italic: 'font-style:italic', underline: 'text-decoration:underline', strike: 'text-decoration:line-through',
};

export interface InlineDirectiveSpec {
  description: string;
  /** Whether [content] is required. */
  content: boolean;
  attrs: string[];
  example: string;
  /** Allowed values for enumerated attributes. */
  values?: Record<string, string[]>;
}

export const INLINE_DIRECTIVES: Record<string, InlineDirectiveSpec> = {
  badge: { description: 'Colored pill label', content: true, attrs: ['color'], example: ':badge[Shipped]{color=green}' },
  kbd: { description: 'Keyboard key', content: true, attrs: [], example: ':kbd[Ctrl+Shift+P]' },
  progress: { description: 'Progress bar, value 0–100', content: false, attrs: ['value', 'color', 'label'], example: ':progress{value=60}' },
  mention: { description: 'Person or team mention', content: true, attrs: [], example: ':mention[@platform-team]' },
  status: {
    description: 'Status dot + label',
    content: true,
    attrs: ['color'],
    example: ':status[On track]{color=green}',
  },
  priority: { description: 'Priority pill, colored automatically (P0–P4 or critical/high/medium/low)', content: true, attrs: [], example: ':priority[P1]' },
  due: { description: 'Due date (YYYY-MM-DD); shown red when overdue, amber when due within 7 days', content: true, attrs: [], example: ':due[2026-10-15]' },
  metric: {
    description: 'KPI tile: value, label and optional delta/trend',
    content: true,
    attrs: ['label', 'delta', 'trend', 'good'],
    values: { trend: ['up', 'down', 'flat'], good: ['up', 'down'] },
    example: ':metric[42%]{label="Activation" delta="+3%" trend=up}',
  },
};

/** Known front-matter keys. Unknown keys are allowed but reported as hints. */
export const FRONTMATTER_KEYS: Record<string, string> = {
  smd: 'Styled Markdown spec version (currently 1)',
  title: 'Document title',
  summary: 'One or two sentence summary — agents read this first',
  status: 'draft | review | approved | deprecated | archived',
  owners: 'List of owners (people or teams)',
  audience: 'Who it is for: humans | agents | both',
  tags: 'List of tags',
  version: 'Document version',
  updated: 'Last updated date (YYYY-MM-DD)',
  created: 'Created date (YYYY-MM-DD)',
  theme: 'Preview theme hint: auto | light | dark',
  accent: 'Accent color used for headings and links (named color or #hex)',
  toc: 'true to render a table of contents after the header',
  related: 'List of related documents (paths or URLs)',
};

export const STATUS_VALUES = ['draft', 'review', 'approved', 'deprecated', 'archived'];
export const AUDIENCE_VALUES = ['humans', 'agents', 'both'];

export const MERMAID_TYPES = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'requirementDiagram', 'gitGraph',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'mindmap', 'timeline',
  'zenuml', 'sankey-beta', 'sankey', 'xychart-beta', 'xychart', 'block-beta', 'block', 'packet-beta',
  'packet', 'kanban', 'architecture-beta', 'architecture', 'radar-beta', 'treemap-beta',
];
