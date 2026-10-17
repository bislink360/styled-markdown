import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPORT_ALIASES, EXPORT_FORMATS, EXPORT_HELP, EXPORT_USAGE, exportFormat, inferExportFormat, type ExportArgs } from '../src/exportCommand';
import { DOCX_MISSING_PANDOC } from '../src/docx';

// ---- Choosing the format ----

function args(values: Record<string, string>, positional = ['doc.smd']): ExportArgs {
  return { positional, flags: new Set(), values: new Map(Object.entries(values).map(([k, v]) => [k, [v]])) };
}

test('smd export: the formats are every single-document export, and the old names map onto them', () => {
  assert.deepEqual(EXPORT_FORMATS, ['html', 'md', 'pdf', 'docx', 'confluence', 'notion']);
  assert.deepEqual([...EXPORT_ALIASES], [['render', 'html'], ['to-md', 'md'], ['pdf', 'pdf'], ['docx', 'docx']]);
});

test('smd export: --to names the format in any case and wins over the extension of -o', () => {
  assert.deepEqual(exportFormat(args({ '--to': 'html' })), { format: 'html' });
  assert.deepEqual(exportFormat(args({ '--to': 'Confluence' })), { format: 'confluence' });
  assert.deepEqual(exportFormat(args({ '--to': 'docx', '-o': 'page.html' })), { format: 'docx' });
  assert.deepEqual(exportFormat(args({ '--to': 'notion', '-o': 'blocks.md' })), { format: 'notion' });
});

test('smd export: without --to, the extension of -o picks html, md, pdf or docx', () => {
  assert.deepEqual(exportFormat(args({ '-o': 'out/page.html' })), { format: 'html' });
  assert.deepEqual(exportFormat(args({ '-o': 'README.MD' })), { format: 'md' });
  assert.deepEqual(exportFormat(args({ '-o': 'plan.pdf' })), { format: 'pdf' });
  assert.deepEqual(exportFormat(args({ '-o': 'plan.Docx' })), { format: 'docx' });
  for (const out of ['plan.xml', 'plan.json', 'plan.htm', 'plan.markdown', 'plan', '.html.bak']) assert.equal(inferExportFormat(out), undefined, out);
});

test('smd export: no format, an empty one, an unknown one or an unknown extension is a usage error listing the formats', () => {
  const problem = (values: Record<string, string>) => {
    const choice = exportFormat(args(values));
    assert.ok('problem' in choice, JSON.stringify(values));
    assert.ok(choice.problem.endsWith(EXPORT_USAGE));
    return choice.problem;
  };
  assert.match(problem({}), /^smd export needs --to <format>\./);
  assert.match(problem({ '--to': '' }), /^--to needs a format\./);
  assert.match(problem({ '--to': 'word' }), /^Unknown export format "word"\.\n/);
  assert.match(problem({ '--to': 'htm' }), /^Unknown export format "htm"\. Did you mean "html"\?/);
  assert.match(problem({ '-o': 'plan.xml' }), /^Cannot tell the format from "plan\.xml": give --to <format>\./);
  assert.match(EXPORT_USAGE, /--to html\|md\|pdf\|docx\|confluence\|notion/);
  assert.match(EXPORT_USAGE, /\(\.html, \.md, \.pdf, \.docx\)/);
});

// ---- The CLI (requires `npm run build`) ----

const cli = join(__dirname, '..', 'dist', 'cli.js');
const skip = !existsSync(cli) && 'run npm run build first';
const corpusDir = join(__dirname, 'compat', 'corpus');
const corpus = readdirSync(corpusDir).filter((f) => f.endsWith('.smd')).sort((a, b) => a.localeCompare(b)).map((f) => join(corpusDir, f));
const showcase = join(__dirname, '..', '..', 'examples', 'showcase.smd');

interface Result { status: number; stdout: string; stderr: string }

const run = (argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Result => {
  const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', ...options });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

const runAsync = (argv: string[]) => new Promise<Result>((resolve) => {
  execFile(process.execPath, [cli, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ status: err ? Number(err.code ?? 1) : 0, stdout, stderr });
  });
});

/** Run the jobs a few at a time: each is two CLI processes. */
async function pool<T>(jobs: Array<() => Promise<T>>, size = 6): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

/** For each corpus document: the old command and its smd export form. */
const PAIRS: Array<[string, (file: string) => [string[], string[]]]> = [
  ['html', (f) => [['render', f], ['export', f, '--to', 'html']]],
  ['html --lang', (f) => [['render', f, '--lang', 'de'], ['export', '--lang', 'de', '--to', 'html', f]]],
  ['md', (f) => [['to-md', f], ['export', f, '--to', 'md']]],
  ['docx --html-only', (f) => [['docx', f, '--html-only'], ['export', f, '--to', 'docx', '--html-only']]],
  ['docx --html-only --lang', (f) => [['docx', f, '--html-only', '--lang', 'fr'], ['export', f, '--to', 'docx', '--html-only', '--lang', 'fr']]],
  ['confluence (argument order)', (f) => [['export', '--to', 'confluence', f], ['export', f, '--to', 'confluence']]],
  ['notion (argument order)', (f) => [['export', '--to', 'notion', f], ['export', f, '--to', 'notion']]],
];

test('CLI: smd export --to html|md|docx --html-only|confluence|notion matches the old commands byte for byte on the corpus', { skip }, async () => {
  assert.ok(corpus.length >= 20);
  const jobs = corpus.flatMap((file) => PAIRS.map(([label, pair]) => async () => {
    const [before, after] = pair(file);
    const [old, now] = await Promise.all([runAsync(before), runAsync(after)]);
    return { label: `${label}: ${file}`, old, now };
  }));
  for (const { label, old, now } of await pool(jobs)) {
    assert.equal(old.status, 0, `${label}\n${old.stderr}`);
    assert.equal(now.status, old.status, label);
    assert.ok(now.stdout.length > 0, label);
    assert.ok(now.stdout === old.stdout, `${label}: output differs`);
    assert.equal(now.stderr, old.stderr, label);
  }
});

test('CLI: -o writes the same file as the old command, with or without --to', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-export-'));
  try {
    const out = (name: string) => join(dir, name);
    const cases: Array<[string[], string[], string]> = [
      [['render', showcase, '-o', out('a.html')], ['export', showcase, '-o', out('b.html')], 'html'],
      [['render', showcase, '-o', out('c.html')], ['export', showcase, '--to', 'html', '-o', out('d.html')], 'html'],
      [['to-md', showcase, '-o', out('a.md')], ['export', showcase, '-o', out('b.MD')], 'md'],
      [['export', '--to', 'confluence', showcase, '-o', out('a.xml')], ['export', showcase, '--to', 'confluence', '-o', out('b.xml')], 'confluence'],
      [['export', '--to', 'notion', showcase, '-o', out('a.json')], ['export', showcase, '--to', 'notion', '-o', out('b.json')], 'notion'],
      [['docx', showcase, '--html-only', '-o', out('a.htm')], ['export', showcase, '--to', 'docx', '--html-only', '-o', out('b.htm')], 'docx'],
    ];
    for (const [before, after, label] of cases) {
      const old = run(before);
      const now = run(after);
      assert.equal(old.status, 0, `${label}: ${old.stderr}`);
      assert.equal(now.status, 0, `${label}: ${now.stderr}`);
      assert.equal(now.stdout, '');
      assert.match(now.stderr, /^Wrote /);
      assert.ok(readFileSync(before.at(-1)!).equals(readFileSync(after.at(-1)!)), label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in for Playwright, found in the working directory: its "PDF" is the print options and the page it was given. */
const FAKE_PLAYWRIGHT = `const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
exports.chromium = {
  launch: async () => ({
    newPage: async () => {
      let url = '';
      return {
        goto: async (u) => { url = u; },
        waitForFunction: async () => true,
        evaluate: async () => undefined,
        pdf: async (options) => Buffer.from(JSON.stringify(options) + '\\n' + fs.readFileSync(fileURLToPath(url), 'utf8')),
      };
    },
    close: async () => undefined,
  }),
};
`;

test('CLI: smd export --to pdf prints the same page with the same options as smd pdf', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-export-pdf-'));
  try {
    const pkg = join(dir, 'node_modules', 'playwright');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{ "name": "playwright", "main": "index.js" }\n');
    writeFileSync(join(pkg, 'index.js'), FAKE_PLAYWRIGHT);
    const doc = join(dir, 'plan.smd');
    copyFileSync(showcase, doc);
    const inDir = (argv: string[]) => run(argv, { cwd: dir });
    const pdfs: Array<[string[], string[]]> = [
      [['pdf', doc, '-o', 'a.pdf'], ['export', doc, '--to', 'pdf', '-o', 'b.pdf']],
      [['pdf', doc, '-o', 'c.pdf', '--format', 'letter', '--landscape', '--lang', 'de'], ['export', doc, '-o', 'd.pdf', '--format', 'letter', '--landscape', '--lang', 'de']],
    ];
    for (const [before, after] of pdfs) {
      const old = inDir(before);
      const now = inDir(after);
      assert.equal(old.status, 0, old.stderr);
      assert.equal(now.status, 0, now.stderr);
      assert.match(now.stderr, /Wrote .*\.pdf \(printed with playwright\)/);
      const output = (argv: string[]) => readFileSync(join(dir, argv[argv.indexOf('-o') + 1]));
      const a = output(before);
      assert.ok(a.equals(output(after)), before.join(' '));
      assert.match(a.toString('utf8'), /data-smd-theme-pref="light"/);
    }
    assert.match(readFileSync(join(dir, 'c.pdf'), 'utf8'), /^\{"format":"Letter","landscape":true,/);

    // Without -o, next to the document, as smd pdf.
    assert.equal(inDir(['pdf', doc]).status, 0);
    const first = readFileSync(join(dir, 'plan.pdf'));
    rmSync(join(dir, 'plan.pdf'));
    assert.equal(inDir(['export', doc, '--to', 'pdf']).status, 0);
    assert.ok(first.equals(readFileSync(join(dir, 'plan.pdf'))));

    // Errors exit as smd pdf does.
    for (const [before, after] of [[['pdf', doc, '--format', 'A3'], ['export', doc, '--to', 'pdf', '--format', 'A3']], [['pdf', doc, '--lang', '!!'], ['export', doc, '-o', 'e.pdf', '--lang', '!!']]]) {
      const old = inDir(before);
      const now = inDir(after);
      assert.equal(old.status, 2);
      assert.equal(now.status, 2);
      assert.equal(now.stderr, old.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The environment without PATH and SMD_PANDOC (any case), with PATH set to `path`. */
function envWithPath(path: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['path', 'smd_pandoc'].includes(k.toLowerCase())));
  return { ...env, PATH: path };
}

test('CLI: smd export --to docx without Pandoc exits 2 as smd docx does; -o file.docx picks docx', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-export-docx-'));
  try {
    const env = envWithPath(dir);
    const old = run(['docx', showcase, '-o', join(dir, 'a.docx')], { env });
    for (const argv of [['export', showcase, '--to', 'docx', '-o', join(dir, 'b.docx')], ['export', showcase, '-o', join(dir, 'b.docx')]]) {
      const now = run(argv, { env });
      assert.equal(now.status, 2);
      assert.equal(now.stderr, old.stderr);
      assert.equal(now.stderr.trim(), DOCX_MISSING_PANDOC);
    }
    assert.equal(existsSync(join(dir, 'b.docx')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd export --to docx runs Pandoc as smd docx does', { skip: skip || (process.platform === 'win32' && 'a stand-in Pandoc needs a POSIX shebang') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-export-pandoc-'));
  try {
    // A stand-in Pandoc: writes its arguments (but the output path) and its input to --output.
    const pandoc = join(dir, 'pandoc');
    writeFileSync(pandoc, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out, JSON.stringify(args.filter((a) => a !== out)) + '\\n' + fs.readFileSync(0, 'utf8'));
`);
    chmodSync(pandoc, 0o755);
    const old = run(['docx', showcase, '--pandoc', pandoc, '-o', join(dir, 'a.docx')]);
    const now = run(['export', showcase, '--pandoc', pandoc, '-o', join(dir, 'b.docx')]);
    assert.equal(old.status, 0, old.stderr);
    assert.equal(now.status, 0, now.stderr);
    assert.ok(readFileSync(join(dir, 'a.docx')).equals(readFileSync(join(dir, 'b.docx'))));
    assert.match(readFileSync(join(dir, 'b.docx'), 'utf8'), /^\["--from","html","--to","docx","--output","--resource-path",/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: usage errors exit 2 and list the formats; a missing file exits 2 as before', { skip }, () => {
  const usage = (argv: string[], message: RegExp) => {
    const r = run(argv);
    assert.equal(r.status, 2, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, message);
    assert.ok(r.stderr.includes('smd export <file.smd> --to html|md|pdf|docx|confluence|notion'), argv.join(' '));
  };
  usage(['export', showcase], /^smd export needs --to <format>\./);
  usage(['export', showcase, '--to'], /^--to needs a format\./);
  usage(['export', showcase, '--to', 'markdown'], /^Unknown export format "markdown"\./);
  usage(['export', showcase, '--to', 'htlm'], /Did you mean "html"\?/);
  usage(['export', showcase, '-o', 'plan.xml'], /^Cannot tell the format from "plan\.xml"/);
  const dir = mkdtempSync(join(tmpdir(), 'smd-export-'));
  try {
    assert.equal(existsSync(join(dir, 'plan.xml')), false);
    for (const [before, after] of [
      [['render', join(dir, 'missing.smd')], ['export', join(dir, 'missing.smd'), '--to', 'html']],
      [['to-md'], ['export', '--to', 'md']],
      [['render', showcase, '--lang', '!!'], ['export', showcase, '--to', 'html', '--lang', '!!']],
      [['export', '--to', 'notion', showcase, '--lang', '!!'], ['export', showcase, '--to', 'notion', '--lang', '!!']],
    ]) {
      const old = run(before);
      const now = run(after);
      assert.equal(old.status, 2, before.join(' '));
      assert.equal(now.status, 2, after.join(' '));
      assert.equal(now.stderr, old.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd --help lists smd export with its formats and a line for the older names, not the old commands', { skip }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes(EXPORT_HELP));
  assert.match(help.stdout, /\n {2}smd export <file\.smd> --to <format> \[-o <file>\] \[--lang <tag>\]/);
  for (const format of EXPORT_FORMATS) assert.match(help.stdout, new RegExp(`\\n {6}${format} +\\S`), format);
  assert.match(help.stdout, /Older names, which still work with the same options and output: smd render \(--to html\),\n\s+smd to-md \(--to md\), smd pdf \(--to pdf\) and smd docx \(--to docx\)\./);
  for (const old of ['render', 'to-md', 'pdf', 'docx']) assert.doesNotMatch(help.stdout, new RegExp(`\\n {2}smd ${old} `), old);
  assert.doesNotMatch(help.stdout, /smd export --to confluence\|notion/);

  const exportHelp = run(['export', '--help']);
  assert.equal(exportHelp.status, 0);
  assert.equal(exportHelp.stdout, `${EXPORT_USAGE}\n\n${EXPORT_HELP}\n`);
  assert.equal(run(['export', '-h']).stdout, exportHelp.stdout);
});
