import { parseFrontMatter } from './frontmatter';
import {
  cycleText, findIncludes, hasIncludes, includePath, includeRequest, innerScope, INCLUDE_LIMITS, isHeadingLevel, loadInclude, rootScope,
  type IncludeBlock, type IncludeFailure, type IncludeRequest, type IncludeScope, type IncludeSource, type LoadedInclude,
} from './include';
import { includeSource } from './includeText';
import { specVersion, type SpecVersion } from './specVersion';
import { anchorIds } from './links';
import { renderSmd } from './render';
import { attrValueFix } from './fixes';
import { findSection, matchesExactly, sectionsOf } from './sections';
import type { Fix, Severity } from './validate';

/**
 * Validation of `:::include` blocks. Every problem is a warning: the block still renders, with its fallback. Sections
 * are found as the including document's spec version finds them (SPEC §3.4). In spec v1, a section found only by a part
 * of its heading's text is an info (`include/section-match`), since spec v2 matches exactly; a spec v2 document never
 * finds one that way, so its section is missing instead (`include/missing-section`).
 */

/** Reports a problem on `line`, columns [column, endColumn): a warning unless `severity` says otherwise. */
export type IncludeReport = (line: number, column: number, endColumn: number, code: string, message: string, severity?: Severity, fix?: Fix) => void;

export interface IncludeCheckOptions {
  fileExists?: (relativePath: string) => boolean;
  readFile?: (relativePath: string) => string | undefined;
}

/**
 * Attributes always; with a reader, also that each file and section can be included, and that the includes it
 * leads to end without a cycle, within the depth and size limits. Problems inside an included file that don't
 * stop it from being included are reported when that file is validated.
 */
export function checkIncludes(text: string, report: IncludeReport, options: IncludeCheckOptions): void {
  const lines = text.split(/\r?\n/);
  const scope = rootScope(text);
  const source = includeSource(options.readFile);
  const fm = parseFrontMatter(text);
  const spec = specVersion(fm.data);
  for (const block of findIncludes(lines, fm.bodyStartLine, undefined, spec)) {
    checkInclude(block, lines[block.line], { scope, source, report, options, spec });
  }
}

interface Check {
  scope: IncludeScope;
  source: IncludeSource;
  report: IncludeReport;
  options: IncludeCheckOptions;
  /** The document's spec version, which included text is read with too. */
  spec: SpecVersion;
}

function checkInclude(block: IncludeBlock, raw: string, check: Check): void {
  const at = (s: string): [number, number] => {
    const c = raw.indexOf(s);
    return c < 0 ? [0, raw.length] : [c, c + s.length];
  };
  const { report, options } = check;
  const level = block.info.attrs.values.level;
  if (level !== undefined && !isHeadingLevel(Number(level))) {
    report(block.line, ...at('level'), 'attrs/value', `level="${level}" should be a heading level from 1 to 6.`);
  }
  const request = includeRequest(block.info.attrs.values);
  if (!request) {
    report(block.line, ...at('include'), 'attrs/required', '":::include" needs a file attribute, e.g. :::include{file="shared/terms.smd"}.');
    return;
  }
  const problem = includeProblem(request, check);
  if (problem) report(block.line, ...at(request.file), problem.code, problem.message);
  else if (request.section) sectionMatch(block, raw, request, check);
}

/**
 * `section="deploy"` that finds `## Rapid deployment` only because the heading's text contains it. Spec v2 matches an
 * exact id or the whole heading text, so this is an info, with a fix to the id of the heading it finds. Spec v1 only.
 */
function sectionMatch(block: IncludeBlock, raw: string, request: IncludeRequest, check: Check): void {
  if (check.scope.spec === 2) return;
  const path = includePath('', request.file);
  const text = check.source.readFile?.(path);
  if (text === undefined || !request.section) return;
  const hit = findSection(sectionsOf(check.source.headings(text), text.split(/\r?\n/).length), request.section);
  if (!hit || matchesExactly(hit.heading, request.section)) return;
  const written = block.info.attrs.values.section ?? request.section;
  const column = raw.indexOf(written);
  const [start, end] = column < 0 ? [0, raw.length] : [column, column + written.length];
  const { text: heading, slug } = hit.heading;
  check.report(block.line, start, end, 'include/section-match',
    `section="${request.section}" finds the heading "${heading}" in "${path}" only by a part of its text. In spec v2 (smd: 2) section= matches a heading's id or its whole text, so this include would find nothing. Use the heading's id: section="${slug}".`,
    'info', attrValueFix(block.line, raw, raw.indexOf('include'), raw.length, 'section', written, slug));
}

/** The first problem an include leads to, with its rule code. */
function includeProblem(request: IncludeRequest, check: Check): { code: string; message: string } | undefined {
  const path = includePath('', request.file);
  if (!check.options.readFile) {
    const missing = check.options.fileExists && !check.options.fileExists(path);
    return missing ? { code: 'include/missing-file', message: `Cannot include "${path}": the file does not exist.` } : undefined;
  }
  const result = loadInclude(request, check.scope, check.source);
  const failure = result.ok ? nestedFailure(result.include, check.scope, check.source, check.spec) : result;
  return failure && problemOf(failure, check.options);
}

/** A cycle, or a limit, that a loaded include runs into further down. */
function nestedFailure(include: LoadedInclude, outer: IncludeScope, source: IncludeSource, spec: SpecVersion): IncludeFailure | undefined {
  const scope = innerScope(outer, include);
  for (const block of findIncludes(include.lines, include.start, include.end, spec)) {
    const request = includeRequest(block.info.attrs.values);
    const result = request && loadInclude(request, scope, source);
    if (!result) continue;
    const failure = result.ok ? nestedFailure(result.include, scope, source, spec) : result;
    if (failure && failure.problem !== 'missing-file' && failure.problem !== 'missing-section') return failure;
  }
  return undefined;
}

function problemOf(failure: IncludeFailure, options: IncludeCheckOptions): { code: string; message: string } | undefined {
  const { path, request } = failure;
  switch (failure.problem) {
    case 'missing-file':
      return options.fileExists?.(path)
        ? { code: 'include/outside-workspace', message: `Cannot include "${path}": it is outside the folders this document may read files from, or unreadable.` }
        : { code: 'include/missing-file', message: `Cannot include "${path}": the file does not exist.` };
    case 'missing-section':
      return { code: 'include/missing-section', message: `No section matching "${request.section}" in "${path}".` };
    case 'cycle':
      return { code: 'include/cycle', message: `Include cycle: ${cycleText(failure.chain ?? [path])}. The repeated include shows its fallback instead.` };
    case 'depth':
      return { code: 'include/depth', message: `Includes nest more than ${INCLUDE_LIMITS.depth} deep at "${path}"; deeper ones show their fallback.` };
    case 'too-large':
      return {
        code: 'include/too-large',
        message: `Too much included content at "${path}" (a document includes at most ${INCLUDE_LIMITS.count} times and ${INCLUDE_LIMITS.chars} characters).`,
      };
    default:
      return undefined;
  }
}

/** Ids a `#fragment` in the document can point at, the headings its includes bring in included. */
export function documentIds(text: string, readFile?: (relativePath: string) => string | undefined): Set<string> {
  const ids = anchorIds(text);
  if (!readFile || !hasIncludes(text)) return ids;
  for (const h of renderSmd(text, { readFile }).headings) ids.add(h.slug);
  return ids;
}

const FIGURE_ID = /<figure id="([^"]+)" class="smd-figure /g;

/** Ids of the figures the document's includes bring in, which `:ref[id]` may name (none without includes). */
export function includedFigureIds(text: string, readFile?: (relativePath: string) => string | undefined): Set<string> {
  if (!readFile || !hasIncludes(text)) return new Set();
  const html = renderSmd(text, { readFile }).html;
  return new Set([...html.matchAll(FIGURE_ID)].map((m) => decodeHtml(m[1])));
}

const TERM_USE = /<a class="smd-term" href="#([^"]+)"/g;

/** Ids of the glossary terms the rendered document uses, included text too (none without includes). */
export function includedTermIds(text: string, readFile?: (relativePath: string) => string | undefined): Set<string> {
  if (!readFile || !hasIncludes(text)) return new Set();
  const html = renderSmd(text, { readFile }).html;
  return new Set([...html.matchAll(TERM_USE)].map((m) => decodeHtml(m[1])));
}

const decodeHtml = (s: string) => s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
