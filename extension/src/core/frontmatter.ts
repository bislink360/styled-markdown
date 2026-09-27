import yaml from 'js-yaml';

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
    const loaded = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
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

export function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
