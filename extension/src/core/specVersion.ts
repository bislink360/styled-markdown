import { parseFrontMatter } from './frontmatter';
import { own } from './util';

/**
 * The spec version of a document: which rules read it (docs/SPEC.md §10). This module is the one place that
 * decides it; nothing else reads the `smd` key's value.
 *
 * The front matter key `smd` selects it:
 * - `smd: 2` (or `"2"`) is spec v2.
 * - `smd: 1`, no `smd` key, no front matter, and front matter that doesn't parse are spec v1.
 * - A value that isn't a positive whole number or a string of digits (`true`, `[2]`, `1.5`, `"v2"`, `0`) is
 *   spec v1, and a `frontmatter/version` warning.
 * - A whole number above the newest version this tool knows (`smd: 3`) is read with the newest rules ({@link
 *   LATEST_SPEC}), with a `frontmatter/version` warning, so the document stays readable.
 * The value as YAML reads it decides: `smd: 2.0` is the number 2, so it is v2 (the validator asks for `smd: 2`).
 *
 * Hosts that can't see the front matter pass a `spec: 1 | 2` option (`renderSmd`, the markdown-it plugin, the
 * remark and rehype plugins). **The front matter wins:** when the document has an `smd` key, the key decides,
 * even if its value is invalid (then it is v1); the option only decides for a document without one.
 *
 * How a rule checks the version, so every reader agrees:
 * - **markdown-it rules** (renderSmd, the plugin, `parseSmd`, the Block Editor's segmenter and inline scanner,
 *   the exporters) call `isV2(state.env)` (or `specOf(env)`). renderSmd, `parseSmd` and `scanInline` put
 *   `smdSpec` on the env before parsing, and the plugin's `smd_spec` core rule does for hosts. An inline render
 *   inside a rule passes `{ smdSpec: specOf(env) }` (or the whole env) along. Included files are read with the
 *   including document's version: they are parsed into its tokens, with its env.
 * - **Tools that have the text** (agent view, `to-md`, `from-md`, tasks, query, meta, the validator, `fmt`) call
 *   `specVersion(text)`; with the front matter already parsed, `specVersion(fm.data)`, which reads one key and
 *   never parses again; with a `parseSmd(text)` at hand, its `spec`.
 *
 * Where each reader finds it today:
 * | Reader                                   | The version                                                         |
 * | ---------------------------------------- | ------------------------------------------------------------------- |
 * | renderSmd, `smd render`, preview, site   | `env.smdSpec` in the rules; `RenderResult.spec`                     |
 * | markdown-it plugin                       | `env.smdSpec`, set by the `smd_spec` core rule (hostSpec)           |
 * | remark / rehype plugins                  | `env.smdSpec` (through renderSmd); `file.data.smd.spec`             |
 * | parseSmd (headings, ids, code lines…)    | `env.smdSpec` in its block parses; `ParseResult.spec`               |
 * | Block Editor segmenter and blocks        | `parseSmdTokens(…).spec` / `env.smdSpec` (blocks.ts)                |
 * | Block Editor inline scanner              | `scanInline(lines, { spec })` → `env.smdSpec`                       |
 * | exporters (Confluence, Notion, Word…)    | `parseSmdTokens(…).env.smdSpec` (exportTree.ts), pandoc via render  |
 * | agent view, outline, query, meta, tasks  | `specVersion(fm.data)` beside their `parseFrontMatter(text)`        |
 * | validator, `fmt`, `to-md`, catalog       | `specVersion(fm.data)` / `parseSmd(text).spec`                      |
 * | `from-md`                                | writes `smd: ${SMD_VERSION}`; Markdown input is always v1           |
 */

/** A spec version this tool has rules for. */
export type SpecVersion = 1 | 2;

/** The newest spec version this tool knows. */
export const LATEST_SPEC = 2 satisfies SpecVersion;

/** Every spec version this tool has rules for, oldest first. */
export const SPEC_VERSIONS: readonly SpecVersion[] = [1, 2];

/**
 * How a document's `smd` value reads: `missing` (no key), `valid` (1 or 2), `newer` (a whole number above
 * {@link LATEST_SPEC}) or `invalid` (anything else).
 */
export type SpecStatus = 'missing' | 'valid' | 'newer' | 'invalid';

export interface SpecReading {
  /** The rules the document is read with. */
  version: SpecVersion;
  status: SpecStatus;
  /** The whole number the document declares, for `valid` and `newer`. */
  declared?: number;
}

/** What a render env says about the version: renderSmd and the plugin's `smd_spec` rule set it before parsing. */
export interface SpecEnv {
  smdSpec?: SpecVersion;
}

const DIGITS = /^\d+$/;
const KEY = 'smd';

/** Whether `value` is a spec version this tool has rules for (for options and envs from JavaScript callers). */
export function isSpecVersion(value: unknown): value is SpecVersion {
  return value === 1 || value === 2;
}

/** How an `smd` front matter value reads (undefined: no key). */
export function readSpec(value: unknown): SpecReading {
  if (value === undefined) return { version: 1, status: 'missing' };
  const declared = wholeNumber(value);
  if (declared === undefined) return { version: 1, status: 'invalid' };
  if (declared > LATEST_SPEC) return { version: LATEST_SPEC, status: 'newer', declared };
  return { version: declared as SpecVersion, status: 'valid', declared };
}

/** A positive whole number, or a string of digits that is one; undefined for anything else. */
function wholeNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && DIGITS.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The `smd` value of parsed front matter, if it has the key. */
const smdValue = (data: Readonly<Record<string, unknown>> | undefined): unknown => (data ? own(data, KEY) : undefined);

/**
 * The spec version of a document, from its whole text or from its already parsed front matter data (as
 * `parseFrontMatter(text).data`, or front matter a host removed): 1 or 2.
 */
export function specVersion(source: string | Readonly<Record<string, unknown>> | undefined): SpecVersion {
  return readSpec(smdValue(typeof source === 'string' ? parseFrontMatter(source).data : source)).version;
}

/**
 * The version for a render: the front matter's `smd` when it has the key (it wins), else the host's `spec`
 * option when that is 1 or 2, else 1.
 */
export function resolveSpec(data: Readonly<Record<string, unknown>> | undefined, option?: unknown): SpecVersion {
  const reading = readSpec(smdValue(data));
  if (reading.status !== 'missing') return reading.version;
  return isSpecVersion(option) ? option : 1;
}

/**
 * Whether front matter declares a spec version: an `smd` key whose value is one (`smd: 1`, `smd: 2`, or a newer
 * whole number). How a `.md` file opts in to the .smd rules, in VS Code's built-in Markdown preview.
 */
export function declaresSpec(data: Readonly<Record<string, unknown>> | undefined): boolean {
  const { status } = readSpec(smdValue(data));
  return status === 'valid' || status === 'newer';
}

/** The version of the render `env` belongs to (1 outside a render, or when nothing set it). */
export function specOf(env: unknown): SpecVersion {
  const spec = (env as SpecEnv | null | undefined)?.smdSpec;
  return isSpecVersion(spec) ? spec : 1;
}

/** Whether the render `env` belongs to reads with the spec v2 rules: the switch every v2 rule checks. */
export function isV2(env: unknown): boolean {
  return specOf(env) === 2;
}
