import { suggest } from './util';
import type { Diagnostic, Severity } from './validate';

/** Every diagnostic code the validator reports, with what it checks. */
export const RULE_CODES: Record<string, string> = {
  'frontmatter/invalid': 'YAML front matter does not parse, is not a mapping, or is never closed',
  'frontmatter/version': '`smd` version missing or unsupported',
  'frontmatter/unknown-key': 'Non-standard front matter key',
  'frontmatter/status': 'Invalid `status` value',
  'frontmatter/audience': 'Invalid `audience` value',
  'frontmatter/value': 'Value outside the allowed values for its key (e.g. `theme`)',
  'frontmatter/accent': 'Invalid `accent` color',
  'frontmatter/type': 'Front matter value has the wrong type',
  'frontmatter/date': 'Front matter date is not YYYY-MM-DD',
  'frontmatter/duplicate-title': 'The first `# heading` repeats the front matter title',
  'frontmatter/stale': '`updated` is older than the stale limit and the document is not archived or deprecated',
  'frontmatter/lang': '`lang` is not a language tag, or names a language without labels (they render in English)',
  'container/unknown': 'Unknown container name',
  'container/unclosed': 'Container is never closed',
  'container/stray-close': 'Closing `:::` with nothing open',
  'container/parent': 'Container used outside its required parent (`tab` outside `tabs`…)',
  'container/agent-in-skip': '`:::agent` block inside a section marked `{agent=skip}`, which agent views leave out',
  'attrs/syntax': 'Malformed `{…}` attribute list',
  'attrs/unknown': 'Attribute not accepted in this position',
  'attrs/value': 'Invalid attribute value',
  'attrs/required': 'Required attribute missing',
  'directive/unknown': 'Unknown inline directive',
  'directive/content': 'Inline directive needs `[content]`',
  'mermaid/type': 'Unknown Mermaid diagram type',
  'mermaid/empty': 'Empty Mermaid diagram',
  'mermaid/syntax': 'Mermaid diagram does not parse (checked where a Mermaid parser is available: the editor and the CLI)',
  'math/syntax': 'KaTeX parse error',
  'math/unclosed': 'Display math `$$` is never closed',
  'fence/unclosed': 'Code fence is never closed',
  'fence/embed-missing': 'Embedded file is missing or outside the workspace',
  'fence/range': 'Invalid `lines="…"` range',
  'fence/embed-body': 'A `file="…"` embed has a non-empty body',
  'fence/lines-without-file': '`lines="…"` without `file="…"`',
  'include/missing-file': 'The `:::include` file does not exist',
  'include/outside-workspace': 'The `:::include` file is outside the folders the document may read, or unreadable',
  'include/missing-section': 'The `:::include` `section` matches no heading in the file',
  'include/cycle': 'Includes lead back to a document already being included',
  'include/depth': 'Includes nest more than 8 deep',
  'include/too-large': 'Includes read more than a document may (200 includes, 2,000,000 characters)',
  'link/missing-anchor': 'Link to an `#anchor` that does not exist',
  'link/missing-file': 'Link to a relative file that does not exist',
  'link/undefined-reference': 'Reference link with no `[label]: …` definition',
  'figure/duplicate-id': 'Two `:::figure` blocks share an `{#id}`; references go to the first',
  'figure/unknown-ref': '`:ref[id]` names no `:::figure` in this document',
  'figure/kind': 'Invalid `kind` on a `:::figure` (it counts as `figure`)',
  'footnote/undefined': 'Footnote reference `[^label]` with no `[^label]: …` definition (info when the document defines no footnotes)',
  'footnote/unused': 'Footnote definition that nothing references (it is not shown)',
  'footnote/duplicate': 'Second definition of a footnote label (the first one is used)',
  'glossary/entry': 'List item in a `:::glossary` that is not `**Term**: definition`, or has no definition',
  'glossary/duplicate': 'A `:::glossary` term is defined again; its uses link to the first definition',
  'glossary/unused': 'A `:::glossary` term is never used in the text',
  'changelog/date': 'A `:::changelog` release heading has a date that is not YYYY-MM-DD',
  'changelog/order': 'A `:::changelog` lists a newer version below an older one (releases go newest first)',
  'changelog/duplicate': 'A `:::changelog` lists the same version twice',
  'quote/empty': 'A `:::quote` has no text',
  'quote/author': 'A `:::quote` has no `author`',
  'quote/cite': 'A `:::quote` `cite` is not an http(s) or relative URL; it is left out',
  'variable/undefined': '`{{name}}` names no front matter key; it is shown as written',
  'variable/not-text': '`{{name}}` names a front matter mapping or empty value, which has no text',
  'task/overdue': 'Open task past its `:due[…]` date',
  'rules/unknown': 'Suppression comment or rule setting names an unknown rule code',
};

/** `off` removes a rule's diagnostics; a severity replaces the rule's own. */
export type RuleSetting = 'off' | Severity;

/**
 * Rule settings by code. A key may be an exact code (`link/missing-file`), a category (`link/*`) or
 * `*` for every rule; the most specific key wins.
 */
export type RuleSettings = Record<string, RuleSetting>;

const SETTINGS: readonly string[] = ['off', 'error', 'warning', 'info', 'hint'];

/** Does a rule key or suppression pattern (`code`, `category/*` or `*`) name at least one known code? */
export function isKnownRule(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return Object.keys(RULE_CODES).some((c) => c.startsWith(pattern.slice(0, -1)));
  return pattern in RULE_CODES;
}

function matches(pattern: string, code: string): boolean {
  return pattern === '*' || pattern === code || (pattern.endsWith('/*') && code.startsWith(pattern.slice(0, -1)));
}

function settingFor(code: string, rules: RuleSettings): RuleSetting | undefined {
  if (code in rules) return rules[code];
  const category = `${code.split('/')[0]}/*`;
  if (category in rules) return rules[category];
  return rules['*'];
}

/** Apply rule settings: drop diagnostics whose rule is `off` and change the severity of the rest. */
export function applyRuleSettings(diagnostics: Diagnostic[], rules: RuleSettings): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const setting = settingFor(d.code, rules);
    if (setting === 'off') continue;
    out.push(setting ? { ...d, severity: setting } : d);
  }
  return out;
}

/**
 * Check a parsed config file (`smd.config.json` / `.smdrc`). Returns its rule settings and problems
 * such as unknown codes or settings, which callers report where the file is loaded.
 */
export function readRuleConfig(data: unknown): { rules: RuleSettings; problems: string[] } {
  const rules: RuleSettings = {};
  const problems: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { rules, problems: ['The config must be a JSON object.'] };
  const raw = (data as Record<string, unknown>).rules;
  if (raw === undefined) return { rules, problems };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rules, problems: ['"rules" must be an object of rule code → setting.'] };
  for (const [key, value] of Object.entries(raw)) {
    if (!isKnownRule(key)) {
      const hint = suggest(key, Object.keys(RULE_CODES));
      problems.push(`Unknown rule "${key}"${hint ? ` — did you mean "${hint}"?` : '.'}`);
      continue;
    }
    if (typeof value !== 'string' || !SETTINGS.includes(value)) {
      problems.push(`Rule "${key}" must be one of: ${SETTINGS.join(', ')}.`);
      continue;
    }
    rules[key] = value as RuleSetting;
  }
  return { rules, problems };
}

// ---------------------------------------------------------------------------
// Inline suppression comments
// ---------------------------------------------------------------------------

const COMMENT = /<!--\s*smd-(disable-next-line|disable-line|disable|enable)\b([^>]*?)\s*-->/g;

/**
 * Honor suppression comments, outside code fences:
 * - `<!-- smd-disable-next-line [codes] -->` for the line below
 * - `<!-- smd-disable-line [codes] -->` for its own line
 * - `<!-- smd-disable [codes] -->` … `<!-- smd-enable [codes] -->` for a range of lines
 * Codes are separated by spaces or commas and may use `category/*`; no codes means every rule.
 * Unknown codes are reported as `rules/unknown`, with a fix when a close match exists.
 */
export function applySuppressions(text: string, diagnostics: Diagnostic[], reportUnknown = true): Diagnostic[] {
  const lines = text.split(/\r?\n/);
  const suppressed = new Map<number, string[]>();
  const add = (line: number, patterns: string[]) => suppressed.set(line, [...(suppressed.get(line) ?? []), ...patterns]);
  const problems: Diagnostic[] = [];
  let open: string[] = [];
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !raw.slice(mark[0].length).trim()) fence = null;
      if (open.length) add(i, open);
      continue;
    }
    if (mark) fence = { char: mark[1][0], len: mark[1].length };
    let enabledHere: string[] | null = null;
    for (const m of raw.matchAll(COMMENT)) {
      const patterns = m[2].split(/[\s,]+/).filter(Boolean);
      const start = m.index! + m[0].indexOf(m[2].trim() || '-->');
      for (const p of patterns) {
        if (isKnownRule(p)) continue;
        const col = raw.indexOf(p, start);
        const hint = suggest(p, Object.keys(RULE_CODES));
        problems.push({
          line: i, column: col, endColumn: col + p.length, severity: 'warning', code: 'rules/unknown',
          message: `Unknown rule "${p}" in suppression comment${hint ? ` — did you mean "${hint}"?` : '.'}`,
          ...(hint ? { fix: { line: i, column: col, endColumn: col + p.length, replacement: hint, title: `Change to "${hint}"` } } : {}),
        });
      }
      const list = patterns.length ? patterns : ['*'];
      if (m[1] === 'disable-next-line') add(i + 1, list);
      else if (m[1] === 'disable-line') add(i, list);
      else if (m[1] === 'disable') open = [...open, ...list];
      else {
        // smd-enable: re-enable the listed rules (or all) from the next line on.
        open = patterns.length ? open.filter((o) => !patterns.includes(o)) : [];
        enabledHere = open;
      }
    }
    if (open.length && enabledHere === null) add(i, open);
  }

  const kept = diagnostics.filter((d) => !(suppressed.get(d.line) ?? []).some((p) => matches(p, d.code)));
  if (!reportUnknown) return kept;
  return [...kept, ...problems.filter((d) => !(suppressed.get(d.line) ?? []).some((p) => matches(p, d.code)))];
}
