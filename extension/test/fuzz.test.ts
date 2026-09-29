import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  agentView, applyFixes, extractTasks, getDocumentInfo, markdownToSmd, outline, renderSmd, smdToMarkdown, validateSmd,
  type Diagnostic, type ValidateOptions,
} from '../src/core';
import { exampleDocuments, fuzzCase, prng } from './fuzz/generate';

/**
 * Fuzz the core with generated and mutated documents. Every entry point must accept any text: no
 * exceptions, no runaway time, positions inside the document, deterministic output, quick fixes that
 * settle and don't create new problems, and with raw HTML off, no markup or CSS that the author didn't
 * get through the whitelist.
 *
 *   SMD_FUZZ_RUNS=5000 SMD_FUZZ_SEED=42 npm test     more cases, another seed (CI's bench job runs 3000)
 *
 * A failure prints its seed and case, and writes a shrunk reproduction to test/fuzz-failures/ (ignored by git).
 */
const RUNS = Number(process.env.SMD_FUZZ_RUNS ?? 300);
const SEED = Number(process.env.SMD_FUZZ_SEED ?? 20260928);
/** Per call; far above normal (single-digit ms) so only pathological cases, like regex backtracking, trip it. */
const BUDGET_MS = Number(process.env.SMD_FUZZ_BUDGET_MS ?? 2000);

const files: Record<string, string> = { 'src/pricing.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' };
const options: ValidateOptions = {
  fileExists: (p) => p in files || p === 'other.smd' || p === 'a.png',
  readFile: (p) => files[p],
  today: '2026-09-28',
};

const errorCodes = (diagnostics: Diagnostic[]) => new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));

const timed = <T>(name: string, fn: () => T): T => {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  if (ms > BUDGET_MS) throw new Error(`${name} took ${Math.round(ms)} ms (budget ${BUDGET_MS} ms)`);
  return result;
};

/** A style attribute value the whitelist can produce: declarations of safe characters only. */
const SAFE_STYLE = /^[\w\s#%.,():/*;+-]*$/;
const UNSAFE_CSS = /url\(|expression|@import|javascript|behavior|\\/i;

/** Check every invariant for one input; returns what broke, or undefined. */
function check(text: string): string | undefined {
  try {
    const lines = text.split(/\r?\n/);
    const diagnostics = timed('validateSmd', () => validateSmd(text, options));
    for (const d of diagnostics) {
      const len = lines[d.line]?.length;
      if (len === undefined) return `diagnostic ${d.code} on line ${d.line}, past the end (${lines.length} lines)`;
      if (d.column < 0 || d.column > len || d.endColumn <= d.column || d.endColumn > len + 1) {
        return `diagnostic ${d.code} columns ${d.column}-${d.endColumn} outside line ${d.line} (length ${len})`;
      }
      if (!d.code || !d.message || !['error', 'warning', 'info', 'hint'].includes(d.severity)) return `malformed diagnostic ${JSON.stringify(d)}`;
      if (d.fix) {
        const fl = lines[d.fix.line];
        if (fl === undefined || d.fix.column < 0 || d.fix.endColumn < d.fix.column || d.fix.endColumn > fl.length) {
          return `fix for ${d.code} outside the document: ${JSON.stringify(d.fix)}`;
        }
      }
    }
    // Fixes settle: re-validating and re-fixing reaches a fixed point within a few rounds (a fix
    // skipped for overlapping another is applied in the next round).
    let fixed = timed('applyFixes', () => applyFixes(text, diagnostics)).text;
    const after = timed('validateSmd (after fixes)', () => validateSmd(fixed, options));
    // A fix must not create an error, except that renaming `:::ap` to `:::api` exposes the checks of
    // the block it now is (attrs/required, attrs/syntax), which is the point of the rename. Likewise,
    // closing an unclosed code block exposes the checks of its content (embeds, diagrams, math).
    const before = errorCodes(diagnostics);
    const exposed = before.has('fence/unclosed') ? /^(attrs|fence|mermaid|math)\// : /^attrs\//;
    for (const code of errorCodes(after)) {
      if (!before.has(code) && !exposed.test(code)) return `applying fixes introduced error ${code}`;
    }
    let current = after;
    for (let round = 0; ; round++) {
      const next = applyFixes(fixed, current);
      if (next.text === fixed) break;
      if (round === 3) return 'quick fixes never settle';
      fixed = next.text;
      current = validateSmd(fixed, options);
    }

    const rendered = timed('renderSmd', () => renderSmd(text, { readFile: options.readFile, today: options.today }));
    if (timed('renderSmd again', () => renderSmd(text, { readFile: options.readFile, today: options.today })).html !== rendered.html) return 'renderSmd is not deterministic';
    for (const h of rendered.headings) {
      if (h.line < 0 || h.line >= lines.length) return `heading "${h.text}" on line ${h.line}, outside the document`;
    }
    const slugs = rendered.headings.map((h) => h.slug);
    if (new Set(slugs).size !== slugs.length && !/\{[^}]*#/.test(text)) return `duplicate heading ids: ${slugs.join(', ')}`;

    // With raw HTML off, nothing the author wrote may become markup, and styles must pass the whitelist.
    const safe = timed('renderSmd (no HTML)', () => renderSmd(text, { allowHtml: false, readFile: options.readFile, today: options.today })).html;
    if (/<script|<iframe|<object|<embed|<img\b[^>]*\son\w+=/i.test(safe)) return 'raw markup survived with allowHtml: false';
    // Only real tags count: text such as "One\n===" inside math is not an attribute.
    for (const tag of safe.matchAll(/<[a-z][^<>]*>/gi)) {
      if (/\son[a-z]+\s*=/i.test(tag[0])) return `an event handler attribute reached the output: ${tag[0]}`;
    }
    if (/href\s*=\s*"\s*javascript:/i.test(safe)) return 'a javascript: link reached the output';
    for (const m of safe.matchAll(/\sstyle="([^"]*)"/g)) {
      const css = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (!SAFE_STYLE.test(css) || UNSAFE_CSS.test(css)) return `style outside the whitelist: ${css}`;
    }

    for (const brief of [false, true]) {
      const view = timed(`agentView${brief ? ' (brief)' : ''}`, () => agentView(text, { brief, readFile: options.readFile, today: options.today }));
      if (!(view.tokens >= 0) || typeof view.text !== 'string') return 'agentView returned no text';
    }
    timed('outline', () => outline(text, { today: options.today }));
    const info = timed('getDocumentInfo', () => getDocumentInfo(text, options));
    if (info.tasks.done > info.tasks.total) return 'more tasks done than there are';
    for (const item of [...info.outline, ...info.decisions, ...info.risks, ...info.agentBlocks, ...info.diagrams, ...info.tasks.open]) {
      if (item.line < 0 || item.line >= lines.length) return `document info points at line ${item.line}, outside the document`;
    }
    const tasks = timed('extractTasks', () => extractTasks(text, options.today));
    if (tasks.length !== info.tasks.total) return `extractTasks found ${tasks.length} tasks, getDocumentInfo ${info.tasks.total}`;
    for (const t of tasks) {
      if (!/\[[ xX]\]/.test(lines[t.line] ?? '')) return `task "${t.text}" on line ${t.line}, which has no checkbox`;
    }
    timed('smdToMarkdown', () => smdToMarkdown(text, { readFile: options.readFile }));
    timed('markdownToSmd', () => markdownToSmd(text, 'fuzz'));
    return undefined;
  } catch (e) {
    return `threw: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? e}`;
  }
}

/** Remove lines while the input still fails, so a failure is small enough to read. */
function shrink(text: string): string {
  let lines = text.split('\n');
  for (let chunk = Math.max(1, lines.length >> 1), rounds = 0; chunk >= 1 && rounds < 400; rounds++) {
    let removed = false;
    for (let i = 0; i + chunk <= lines.length; ) {
      const candidate = [...lines.slice(0, i), ...lines.slice(i + chunk)];
      if (candidate.length && check(candidate.join('\n'))) { lines = candidate; removed = true; } else i += chunk;
    }
    if (!removed) chunk >>= 1;
  }
  return lines.join('\n');
}

test(`fuzz: ${RUNS} generated documents (seed ${SEED})`, (t) => {
  // KaTeX warns on the console about the Unicode noise in generated math; it is not a failure.
  t.mock.method(console, 'warn', () => {});
  const examples = exampleDocuments();
  const random = prng(SEED);
  for (let i = 0; i < RUNS; i++) {
    const text = fuzzCase(random, examples);
    const problem = check(text);
    if (!problem) continue;
    const small = shrink(text);
    const dir = path.join(__dirname, 'fuzz-failures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `seed-${SEED}-case-${i}.smd`);
    fs.writeFileSync(file, small);
    assert.fail(`case ${i} (SMD_FUZZ_SEED=${SEED}): ${check(small) ?? problem}\nShrunk input: ${path.relative(process.cwd(), file)}`);
  }
});

test('fuzz: every example passes the invariants', () => {
  for (const text of exampleDocuments()) assert.equal(check(text), undefined);
});
