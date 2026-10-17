import yaml, { type Schema, type Type } from 'js-yaml';

export interface FrontMatter {
  /** Parsed YAML (empty object when there is no front matter). */
  data: Record<string, unknown>;
  /** True when a front matter block exists. */
  present: boolean;
  /** Zero-based line index of the first body line. */
  bodyStartLine: number;
  /** Markdown body with the front matter removed. */
  body: string;
  error?: { message: string; line: number };
}

/**
 * Split `---` YAML front matter from the Markdown body. CORE_SCHEMA is used
 * so dates such as `updated: 2026-09-01` stay plain strings.
 */
export function parseFrontMatter(text: string): FrontMatter {
  return splitFrontMatter(text, yaml.CORE_SCHEMA);
}

/** The YAML types whose values a document shows differently from how they are written: `2.10` is 2.1, `True` is true. */
const RESPELLED = ['bool', 'int', 'float'] as const;

/**
 * CORE_SCHEMA, except that a plain scalar YAML reads as a boolean or a number stays the text written in the source
 * (`2.10`, `True`, `0x1F`, `1e3`). Quoted, block and null values read as in CORE_SCHEMA.
 */
const SOURCE_SPELLING = yaml.CORE_SCHEMA.extend({
  implicit: RESPELLED.map((name) => {
    // js-yaml exports its types at run time; its typings leave them (and their tag) out.
    const type = (yaml as unknown as { types: Record<(typeof RESPELLED)[number], Type & { tag: string }> }).types[name];
    return new yaml.Type(type.tag, { kind: 'scalar', resolve: (data: string) => type.resolve(data), construct: (data: string) => data });
  }),
});

/**
 * The front matter data of `text` as spec v2 shows it (SPEC §4.7): what {@link parseFrontMatter} reads, except that
 * every plain number and boolean, in lists and nested mappings too, is the string written in the YAML source
 * (`version: 2.10` is `"2.10"`, not 2.1). Undefined when the text has no front matter, or front matter that doesn't parse.
 */
export function sourceSpelledData(text: string): Record<string, unknown> | undefined {
  const fm = splitFrontMatter(text, SOURCE_SPELLING);
  return fm.present && !fm.error ? fm.data : undefined;
}

function splitFrontMatter(text: string, schema: Schema): FrontMatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') {
    return { data: {}, present: false, bodyStartLine: 0, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (l === '---' || l === '...') { end = i; break; }
  }
  if (end === -1) {
    return {
      data: {}, present: true, bodyStartLine: 0, body: text,
      error: { message: 'Front matter starts with "---" but is never closed.', line: 0 },
    };
  }
  const raw = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    const loaded = yaml.load(raw, { schema });
    if (loaded !== undefined && loaded !== null && (typeof loaded !== 'object' || Array.isArray(loaded))) {
      return {
        data: {}, present: true, bodyStartLine: end + 1, body,
        error: { message: 'Front matter must be a YAML mapping (key: value pairs).', line: 1 },
      };
    }
    return { data: (loaded as Record<string, unknown>) ?? {}, present: true, bodyStartLine: end + 1, body };
  } catch (e) {
    const err = e as { reason?: string; message: string; mark?: { line: number } };
    return {
      data: {}, present: true, bodyStartLine: end + 1, body,
      error: { message: `Invalid YAML front matter: ${err.reason ?? err.message}`, line: 1 + (err.mark?.line ?? 0) },
    };
  }
}

/**
 * The lines of closed front matter that could not be read (its YAML does not parse, or is a list or a scalar), as
 * written: rendering shows them in an error block and the agent view lists them, so nothing above the closing line
 * is hidden. Undefined for any other document (front matter that is never closed is not front matter).
 */
export function unreadFrontMatter(text: string, fm: Pick<FrontMatter, 'bodyStartLine'> & Partial<Pick<FrontMatter, 'error'>>): string[] | undefined {
  if (!fm.error || fm.bodyStartLine < 2) return undefined;
  return text.split(/\r?\n/).slice(1, fm.bodyStartLine - 1);
}

export function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
