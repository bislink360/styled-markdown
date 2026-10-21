import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import {
  agentView, extractTasks, getDocumentInfo, outline, renderSmd, smdToMarkdown, validateSmd, type ValidateOptions,
} from '../../src/core';
import { resetParseCache } from '../../src/core/parse';
import { largeDocument } from '../fuzz/generate';

/**
 * Times the core on large synthetic documents made from the examples.
 *
 *   npm run bench                     print the table
 *   npm run bench -- --check          also fail when a median exceeds its limit (CI does this)
 *   npm run bench -- --sizes 1000     other document sizes, in lines
 *
 * Limits are ceilings, not targets: set about 10x above what a CI runner measures, so they only
 * catch order-of-magnitude regressions (an accidentally quadratic pass), never ordinary noise.
 */

const args = process.argv.slice(2);
const check = args.includes('--check');
const sizesArg = args.indexOf('--sizes');
const SIZES = sizesArg >= 0 ? args[sizesArg + 1].split(',').map(Number) : [1000, 10000];

const options: ValidateOptions = { fileExists: () => true, readFile: () => undefined, today: '2026-09-28' };

const CASES: Array<{ name: string; run: (text: string) => unknown }> = [
  { name: 'renderSmd', run: (t) => renderSmd(t, { today: options.today }) },
  { name: 'validateSmd', run: (t) => validateSmd(t, options) },
  { name: 'agentView', run: (t) => agentView(t, { today: options.today }) },
  { name: 'agentView (brief)', run: (t) => agentView(t, { brief: true, today: options.today }) },
  { name: 'outline', run: (t) => outline(t, { today: options.today }) },
  { name: 'getDocumentInfo', run: (t) => getDocumentInfo(t, options) },
  { name: 'extractTasks', run: (t) => extractTasks(t, options.today) },
  { name: 'smdToMarkdown', run: (t) => smdToMarkdown(t) },
];

/**
 * Median milliseconds allowed, by case and document size: about 5-10x the median of a CI runner
 * (ubuntu, 28 runs before 2.0.2, 1.0k / 10k lines: render 14 / 81 ms, validate 20 / 150,
 * agentView 14 / 109, outline 17 / 164, getDocumentInfo 19 / 166, extractTasks 0.9 / 8.7,
 * smdToMarkdown 13 / 119), with a cold parse cache. smdToMarkdown parses the whole document since
 * 1.10, so its limits match renderSmd's.
 */
const LIMITS: Record<string, Record<number, number>> = {
  renderSmd: { 1000: 100, 10000: 750 },
  validateSmd: { 1000: 120, 10000: 1000 },
  agentView: { 1000: 100, 10000: 900 },
  'agentView (brief)': { 1000: 100, 10000: 900 },
  outline: { 1000: 150, 10000: 1000 },
  getDocumentInfo: { 1000: 200, 10000: 1800 },
  extractTasks: { 1000: 15, 10000: 60 },
  smdToMarkdown: { 1000: 100, 10000: 750 },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function time(run: () => unknown, budgetMs: number): { median: number; runs: number } {
  const w0 = performance.now();
  run(); // warm up the JIT and caches
  const warmup = performance.now() - w0;
  const samples: number[] = [];
  const start = performance.now();
  // Slow cases (seconds per call) get a single timed run, so the suite stays under a minute.
  while ((samples.length < (warmup > budgetMs ? 1 : 3)) || (samples.length < 25 && performance.now() - start < budgetMs)) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  return { median: median(samples), runs: samples.length };
}

const warn = console.warn;
console.warn = () => {}; // KaTeX strict-mode notes are not interesting here

const rows: string[][] = [];
const failures: string[] = [];
for (const size of SIZES) {
  const text = largeDocument(size);
  const lines = text.split('\n').length;
  for (const c of CASES) {
    // Each run parses from scratch: the parse cache would otherwise turn repeats of the same text into hits.
    const measure = (budgetMs: number) => time(() => { resetParseCache(); c.run(text); }, budgetMs);
    const limit = LIMITS[c.name]?.[size];
    let { median: ms, runs } = measure(1500);
    // A busy runner can slow one measurement: a case over its limit is measured again, longer, and fails only if it stays over.
    if (limit !== undefined && ms > limit) ({ median: ms, runs } = measure(5000));
    const over = limit !== undefined && ms > limit;
    if (check && over) failures.push(`${c.name} on ${lines} lines: ${ms.toFixed(1)} ms > limit ${limit} ms`);
    rows.push([c.name, String(lines), ms.toFixed(1), String(runs), limit === undefined ? '-' : String(limit), over ? 'OVER' : 'ok']);
  }
}
console.warn = warn;

const header = ['case', 'lines', 'median ms', 'runs', 'limit ms', ''];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
console.log(fmt(header));
for (const r of rows) console.log(fmt(r));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['### Benchmarks', '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}

if (failures.length) {
  console.error(`\n${failures.length} benchmark(s) over their limit:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
