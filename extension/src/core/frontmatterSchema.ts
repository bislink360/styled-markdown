import { AUDIENCE_VALUES, FRONTMATTER_KEYS, NAMED_COLORS, SMD_VERSION, STATUS_VALUES } from './spec';

/**
 * JSON Schema (draft-07) for .smd front matter. The validator and editor completion read it, and
 * it is published as schemas/smd-frontmatter.schema.json (and `styled-markdown/frontmatter.schema.json`
 * on npm) for YAML tooling and pipelines that check document metadata. Keys it does not list are
 * allowed as custom metadata.
 */
export interface FrontMatterProperty {
  description: string;
  type?: string | string[];
  enum?: Array<string | number>;
  pattern?: string;
  format?: string;
  items?: { type: string };
  anyOf?: Array<Omit<FrontMatterProperty, 'description'>>;
  examples?: unknown[];
}

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const listOf = (description: string, examples: unknown[]): FrontMatterProperty => ({
  description,
  anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
  examples,
});

const PROPERTIES: Record<string, FrontMatterProperty> = {
  smd: { description: FRONTMATTER_KEYS.smd, type: 'integer', enum: [SMD_VERSION] },
  title: { description: FRONTMATTER_KEYS.title, type: 'string' },
  summary: { description: FRONTMATTER_KEYS.summary, type: 'string' },
  status: { description: FRONTMATTER_KEYS.status, type: 'string', enum: STATUS_VALUES },
  owners: listOf(FRONTMATTER_KEYS.owners, [['@maya', '@platform-team']]),
  audience: { description: FRONTMATTER_KEYS.audience, type: 'string', enum: AUDIENCE_VALUES },
  tags: listOf(FRONTMATTER_KEYS.tags, [['checkout', 'q4']]),
  version: { description: FRONTMATTER_KEYS.version, type: ['string', 'number'], examples: ['1.0'] },
  updated: { description: FRONTMATTER_KEYS.updated, type: 'string', format: 'date', pattern: DATE },
  created: { description: FRONTMATTER_KEYS.created, type: 'string', format: 'date', pattern: DATE },
  theme: { description: FRONTMATTER_KEYS.theme, type: 'string', enum: ['auto', 'light', 'dark'] },
  accent: {
    description: FRONTMATTER_KEYS.accent,
    anyOf: [
      { type: 'string', enum: [...NAMED_COLORS] },
      { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' },
      { type: 'string', pattern: '^(?:rgb|rgba|hsl|hsla)\\(\\s*[\\d.%\\s,/-]+\\)$' },
    ],
  },
  toc: { description: FRONTMATTER_KEYS.toc, type: 'boolean' },
  related: listOf(FRONTMATTER_KEYS.related, [['adr-0007-event-bus.smd', 'https://example.com/spec']]),
};

export const FRONTMATTER_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://raw.githubusercontent.com/bislink360/styled-markdown/main/extension/schemas/smd-frontmatter.schema.json',
  title: 'Styled Markdown (.smd) front matter',
  description: 'YAML front matter at the top of a .smd document. Keys not listed here are kept as custom metadata.',
  type: 'object',
  properties: PROPERTIES,
  additionalProperties: true,
} as const;

/** The values a key accepts, for completion: enums, booleans and the schema version. */
export function frontMatterValues(key: string): string[] {
  const prop = PROPERTIES[key];
  if (!prop) return [];
  if (prop.enum) return prop.enum.map(String);
  if (prop.type === 'boolean') return ['true', 'false'];
  const enums = prop.anyOf?.flatMap((a) => a.enum ?? []) ?? [];
  return enums.map(String);
}

/** A front matter key's schema entry, if it is a standard key. */
export const frontMatterProperty = (key: string): FrontMatterProperty | undefined => PROPERTIES[key];
