import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import type { StateInline } from 'markdown-it';
import {
  agentView, extractTasks, formatSmd, getDocumentInfo, indexEntry, outline, parseFrontMatter, parseSmd, querySmd, remarkSmd, renderSmd,
  renderSmdFile, smdToConfluence, smdToMarkdown, smdToNotion, smdToPandocHtml, specVersion, validateSmd, type SmdTree, type SmdVFile,
} from '../src/core';
import smd from '../src/core/markdownIt';
import { renderBlocks, segmentSmd } from '../src/core/blocks';
import { scanInline } from '../src/core/inlineEdit';
import { parseSmdTokens } from '../src/core/render';
import { isSpecVersion, isV2, LATEST_SPEC, readSpec, resolveSpec, specOf, SPEC_VERSIONS } from '../src/core/specVersion';
import { statusBarItem, statusBarState, statusBarText } from '../src/documentStatus';

/** The spec version switch (feat/spec-version): one function decides, every reader gets it, and nothing renders differently yet. */

const today = '2026-10-17';
const doc = (smdLine: string | undefined, body = '# Title\n\nText.\n') => (smdLine === undefined ? body : `---\n${smdLine}\n---\n\n${body}`);

// ---------------------------------------------------------------------------
// specVersion: every kind of value
// ---------------------------------------------------------------------------

test('specVersion: smd: 2 (or "2") is 2; smd: 1, no key, no front matter and broken front matter are 1', () => {
  const cases: Array<[string | undefined, number]> = [
    ['smd: 2', 2], ['smd: "2"', 2], ["smd: '02'", 2], ['smd: 2 # spec v2', 2],
    ['smd: 1', 1], ['smd: "1"', 1], ['smd: 01', 1], ['title: No key', 1], [undefined, 1],
  ];
  for (const [line, version] of cases) assert.equal(specVersion(doc(line)), version, String(line));
  assert.equal(specVersion('---\nsmd: 2\n'), 1, 'front matter that is never closed');
  assert.equal(specVersion('---\nsmd: [2\n---\n'), 1, 'front matter that does not parse');
  assert.equal(specVersion('---\n- smd: 2\n---\n'), 1, 'front matter that is not a mapping');
  assert.equal(specVersion(''), 1);
});

test('specVersion: a whole number above 2 is the newest version this tool knows', () => {
  assert.equal(LATEST_SPEC, 2);
  assert.deepEqual(SPEC_VERSIONS, [1, 2]);
  for (const line of ['smd: 3', 'smd: "3"', 'smd: 99', 'smd: 1000000000000']) assert.equal(specVersion(doc(line)), 2, line);
  assert.deepEqual(readSpec(3), { version: 2, status: 'newer', declared: 3 });
});

test('specVersion: invalid values (booleans, lists, decimals, other strings, zero, null) are 1', () => {
  for (const line of [
    'smd: true', 'smd: false', 'smd: [2]', 'smd: [1]', 'smd: 1.5', 'smd: 2.5', 'smd: "2.0"', 'smd: " 2"', 'smd: v2', 'smd: two',
    'smd: 0', 'smd: "0"', 'smd: -2', 'smd: .inf', 'smd: .nan', 'smd:', 'smd: ~', 'smd: {v: 2}', 'smd:\n  - 2',
  ]) {
    assert.equal(specVersion(doc(line)), 1, line);
  }
});

test('specVersion: the value YAML reads decides, so smd: 2.0 is 2 (the validator asks for smd: 2)', () => {
  assert.equal(specVersion(doc('smd: 2.0')), 2);
  assert.equal(specVersion(doc('smd: 1.0')), 1);
});

test('specVersion reads parsed front matter too, without parsing again', () => {
  assert.equal(specVersion({ smd: 2 }), 2);
  assert.equal(specVersion({ smd: '2' }), 2);
  assert.equal(specVersion({ smd: 7 }), 2);
  assert.equal(specVersion({ smd: true }), 1);
  assert.equal(specVersion({}), 1);
  assert.equal(specVersion(undefined), 1);
  assert.equal(specVersion(parseFrontMatter(doc('smd: 2')).data), 2);
  // Only an own key counts.
  assert.equal(specVersion(Object.create({ smd: 2 }) as Record<string, unknown>), 1);
});

test('readSpec says how a value reads: missing, valid, newer or invalid', () => {
  assert.deepEqual(readSpec(undefined), { version: 1, status: 'missing' });
  assert.deepEqual(readSpec(1), { version: 1, status: 'valid', declared: 1 });
  assert.deepEqual(readSpec('2'), { version: 2, status: 'valid', declared: 2 });
  assert.deepEqual(readSpec('007'), { version: 2, status: 'newer', declared: 7 });
  for (const value of [true, null, [2], { v: 2 }, 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2.0', '', 'x']) {
    assert.deepEqual(readSpec(value), { version: 1, status: 'invalid' }, JSON.stringify(value));
  }
});

test('resolveSpec: the front matter wins over the option; the option fills in for a document without an smd key', () => {
  assert.equal(resolveSpec({}, 2), 2);
  assert.equal(resolveSpec(undefined, 2), 2);
  assert.equal(resolveSpec({ title: 'x' }, 1), 1);
  assert.equal(resolveSpec({}, undefined), 1);
  assert.equal(resolveSpec({ smd: 1 }, 2), 1, 'front matter beats the option');
  assert.equal(resolveSpec({ smd: 2 }, 1), 2);
  assert.equal(resolveSpec({ smd: true }, 2), 1, 'an invalid value still decides: it is version 1');
  assert.equal(resolveSpec({ smd: 5 }, 1), 2);
  assert.equal(resolveSpec({}, 3), 1, 'an option that is not a version is ignored');
  assert.equal(resolveSpec({}, '2'), 1);
});

test('isV2 and specOf read the env; anything that is not a version there is 1', () => {
  assert.equal(isV2({ smdSpec: 2 }), true);
  assert.equal(isV2({ smdSpec: 1 }), false);
  assert.equal(isV2({}), false);
  assert.equal(isV2(undefined), false);
  assert.equal(isV2(null), false);
  assert.equal(specOf({ smdSpec: 3 }), 1);
  assert.equal(specOf({ smdSpec: '2' }), 1);
  assert.equal(isSpecVersion(2), true);
  assert.equal(isSpecVersion(0), false);
});

// ---------------------------------------------------------------------------
// Plumbing: renderSmd, parseSmd, the markdown-it plugin, remark
// ---------------------------------------------------------------------------

test('renderSmd puts the version on the env before parsing and on the result; the spec option fills in, the front matter wins', () => {
  assert.equal(renderSmd(doc('smd: 2')).spec, 2);
  assert.equal(renderSmd(doc('smd: 1')).spec, 1);
  assert.equal(renderSmd(doc(undefined)).spec, 1);
  assert.equal(renderSmd(doc(undefined), { spec: 2 }).spec, 2, 'the option for a document without front matter');
  assert.equal(renderSmd(doc('title: T'), { spec: 2 }).spec, 2, 'the option for front matter without smd');
  assert.equal(renderSmd(doc('smd: 1'), { spec: 2 }).spec, 1, 'the front matter wins');
  assert.equal(parseSmdTokens(doc('smd: 2')).env.smdSpec, 2);
  assert.equal(parseSmdTokens(doc(undefined), { spec: 2 }).env.smdSpec, 2);
  assert.equal(parseSmdTokens(doc('smd: 2')).spec, 2);
  // The option changes nothing else: no v2 rule exists yet.
  assert.equal(renderSmd(doc(undefined), { spec: 2, today }).html, renderSmd(doc(undefined), { today }).html);
});

test('parseSmd says the version, and its incremental cache never mixes versions', () => {
  const body = '# A {{version}}\n\n:::note Title\nText.\n:::\n';
  const v1 = parseSmd(`---\nsmd: 1\nversion: "3"\n---\n${body}`);
  const v2 = parseSmd(`---\nsmd: 2\nversion: "3"\n---\n${body}`);
  assert.deepEqual([v1.spec, v2.spec], [1, 2]);
  assert.deepEqual(v2.headings, v1.headings);
  assert.equal(parseSmd(`---\nsmd: 2\n---\n${body}`).spec, 2, 'without variables');
  assert.equal(parseSmd(`---\nsmd: 1\n---\n${body}`).spec, 1);
  assert.equal(parseSmd(body).spec, 1);
});

/** An inline rule that records the version of each text it is asked about, without changing anything. */
function probe(md: MarkdownIt, seen: Array<[string, number]>): MarkdownIt {
  md.inline.ruler.before('text', 'probe', (state: StateInline) => {
    if (state.pos === 0 && state.src.startsWith('PROBE')) seen.push([state.src, specOf(state.env)]);
    return false;
  });
  return md;
}

test('markdown-it plugin: the spec option sets env.smdSpec for documents that do not say', () => {
  const env: Record<string, unknown> = {};
  new MarkdownIt().use(smd, { spec: 2 }).render('Text.', env);
  assert.equal(env.smdSpec, 2);
  const plain: Record<string, unknown> = {};
  new MarkdownIt().use(smd).render('Text.', plain);
  assert.equal(plain.smdSpec, 1, 'default 1');
});

test('markdown-it plugin: the front matter wins over the option, in the source or passed as env.smdVariables', () => {
  for (const frontMatter of [true, false]) {
    const md = new MarkdownIt().use(smd, { spec: 2, frontMatter });
    const env: Record<string, unknown> = {};
    md.render('---\nsmd: 1\n---\n\nText.\n', env);
    assert.equal(env.smdSpec, 1, `frontMatter: ${frontMatter}`);
  }
  const md = new MarkdownIt().use(smd, { spec: 1 });
  const env: Record<string, unknown> = {};
  md.render('---\nsmd: 2\n---\n\nText.\n', env);
  assert.equal(env.smdSpec, 2);
  const stripped: Record<string, unknown> = { smdVariables: { smd: 1 } };
  new MarkdownIt().use(smd, { spec: 2 }).render('Text.', stripped);
  assert.equal(stripped.smdSpec, 1, 'front matter the host removed and passed along');
  const noKey: Record<string, unknown> = { smdVariables: { title: 'T' } };
  new MarkdownIt().use(smd, { spec: 2 }).render('Text.', noKey);
  assert.equal(noKey.smdSpec, 2, 'host front matter without smd: the option');
});

test('markdown-it plugin: each render works the version out again, so a reused env does not keep the last one', () => {
  const md = new MarkdownIt().use(smd);
  const env: Record<string, unknown> = {};
  md.render('---\nsmd: 2\n---\n\nText.\n', env);
  assert.equal(env.smdSpec, 2);
  md.render('Text.', {});
  const fresh: Record<string, unknown> = {};
  md.render('Text.', fresh);
  assert.equal(fresh.smdSpec, 1);
  md.render('---\nsmd: 1\n---\n\nText.\n', env);
  assert.equal(env.smdSpec, 1);
});

test('the rules see the document\'s version everywhere: text, titles, directive content and included files', () => {
  const included = '# PROBE included heading\n\nPROBE included text\n';
  const readFile = (p: string) => (p === 'part.smd' ? included : undefined);
  const source = (smdLine: string) =>
    `---\n${smdLine}\n---\n\nPROBE text\n\n:::note PROBE title\nx\n:::\n\n:badge[PROBE badge]\n\n:::include{file=part.smd section="probe-included-heading"}\nFallback.\n:::\n`;
  for (const version of [1, 2]) {
    const host: Array<[string, number]> = [];
    probe(new MarkdownIt().use(smd, { readFile }), host).render(source(`smd: ${version}`), {});
    assert.ok(host.length >= 5, JSON.stringify(host));
    assert.deepEqual([...new Set(host.map(([, v]) => v))], [version], `markdown-it host, smd: ${version}: ${JSON.stringify(host)}`);
    // The include scan parses the whole file to find the section: it sees the including document's version too.
    assert.ok(host.some(([s]) => s === 'PROBE included heading'), 'the include scan ran');
  }
  // With the option and no front matter.
  const optioned: Array<[string, number]> = [];
  probe(new MarkdownIt().use(smd, { spec: 2, readFile }), optioned).render(source('title: T').replace(/^---\ntitle: T\n---\n\n/, ''), {});
  assert.deepEqual([...new Set(optioned.map(([, v]) => v))], [2]);
});

test('remark plugin: the spec option and the file\'s front matter, front matter first', () => {
  const run = (value: string, options = {}, data: Record<string, unknown> = {}) => {
    const file: SmdVFile = { value, data };
    const tree: SmdTree = { type: 'root', children: [] };
    remarkSmd(options)(tree, file);
    return (file.data?.smd as { spec: number }).spec;
  };
  assert.equal(run('Text.'), 1);
  assert.equal(run('Text.', { spec: 2 }), 2);
  assert.equal(run('---\nsmd: 1\n---\nText.', { spec: 2 }), 1);
  assert.equal(run('---\nsmd: 2\n---\nText.'), 2);
  assert.equal(run('Text.', { spec: 2 }, { matter: { smd: 1 } }), 1, 'front matter the host removed');
  assert.equal(run('Text.', {}, { frontmatter: { smd: 2 } }), 2);
  assert.equal(renderSmdFile({ value: 'Text.' }, { spec: 2 })?.spec, 2);
});

test('VS Code status bar: the tooltip names spec v2 for a document that opts in; v1 documents show what they did', () => {
  const v2 = statusBarState('---\nsmd: 2\nstatus: draft\n---\n');
  assert.deepEqual(v2, { status: { kind: 'known', status: 'draft' }, spec: 2 });
  assert.equal(statusBarItem(v2.status, v2.spec).tooltip, 'Document status: draft — click to change\nStyled Markdown spec v2 (smd: 2)');
  const v1 = statusBarState('---\nsmd: 1\nstatus: draft\n---\n');
  assert.deepEqual(statusBarItem(v1.status, v1.spec), statusBarText(v1.status));
  assert.deepEqual(statusBarState('# No front matter\n'), { status: { kind: 'missing' }, spec: 1 });
});

// ---------------------------------------------------------------------------
// No rule changes: every reader's output is the same for smd: 1, no key and smd: 2
// ---------------------------------------------------------------------------

const root = path.join(__dirname, '..', '..');
const smdFiles = (dir: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.smd')).map((f) => path.join(dir, f));
const DOCUMENTS = [...smdFiles('examples'), ...smdFiles(path.join('extension', 'test', 'compat', 'corpus'))];

/** The document with its `smd` line written as `line` (one line, so every other line keeps its number). */
function withVersionLine(text: string, line: string): string {
  const fm = parseFrontMatter(text);
  if (!fm.present || fm.error) return `---\n${line}\n---\n${text}`;
  const lines = text.split('\n');
  const at = lines.findIndex((l, i) => i > 0 && i < fm.bodyStartLine && /^smd\s*:/.test(l));
  if (at > 0) lines[at] = line;
  else lines.splice(1, 0, line);
  return lines.join('\n');
}

// Lines of one length (the third a YAML comment), so token estimates of the whole file don't differ either.
const VARIANTS = { v1: 'smd: 1', none: '#smd:1', v2: 'smd: 2' };
const VERSION_CODE = 'frontmatter/version';

/**
 * JSON without what is meant to differ: the `smd` value itself, the version on results, the version diagnostics, and
 * the Block Editor's key of the front matter segment (a hash of its text).
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (key === 'smd' || key === 'spec' || key === 'smdSpec') return undefined;
    if (Array.isArray(v)) return v.filter((d) => (d as { code?: string } | null)?.code !== VERSION_CODE);
    return (v as { kind?: string } | null)?.kind === 'frontmatter' ? { ...(v as object), key: undefined } : v;
  }).replaceAll(VARIANTS.v1, 'SMD').replaceAll(VARIANTS.none, 'SMD').replaceAll(VARIANTS.v2, 'SMD');
}

const READERS: Record<string, (text: string) => unknown> = {
  render: (t) => renderSmd(t, { today }),
  'markdown-it plugin': (t) => new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(smd, { frontMatter: true, headingIds: true, codeFrames: true, sourceLines: true, today }).render(t),
  remark: (t) => renderSmdFile({ value: t }, { today })?.html,
  agent: (t) => agentView(t, { today }).text,
  outline: (t) => outline(t),
  'to-md': (t) => smdToMarkdown(t),
  tasks: (t) => extractTasks(t, today),
  query: (t) => querySmd(t, '*', { today }),
  meta: (t) => getDocumentInfo(t, { today }),
  index: (t) => indexEntry(t, 'doc.smd', { today }),
  validate: (t) => validateSmd(t, { today }),
  fmt: (t) => formatSmd(t),
  'block editor segments': (t) => segmentSmd(t, { today }),
  'block editor render': (t) => renderBlocks(t, { today, inlineIndex: true }),
  'block editor inline scan': (t) => scanInline(t.split('\n'), { spec: specVersion(t) }),
  parse: (t) => parseSmd(t),
  confluence: (t) => smdToConfluence(t),
  notion: (t) => smdToNotion(t),
  pandoc: (t) => smdToPandocHtml(t, { today }),
};

/**
 * The documents that use a spec v2 rule, so that some reader shows them differently with smd: 2, and the rules:
 * headings ending in `{}` or `{word}` (proposal 5), `\\` or a final backslash in a quoted value (6), names outside the
 * vocabulary or not in lower case (7b, 11). Every other document reads the same with either version.
 */
const USES_V2_RULES = new Set([
  'attribute-escapes.smd', // `\\server` and a value ending in a backslash
  'migrate.smd', // `## Object {}`, `:abbr[HTML]`, `\\server`
  'unknown-directives.smd', 'v2-directives.smd', 'v2-escapes.smd', 'v2-headings.smd',
  'v2-hints.smd', // `## Object {}` and `## Returns {ok}`
]);

test('smd: 1 and no smd key read the same; smd: 2 differs only in the documents that use a v2 rule (examples and the corpus)', () => {
  assert.ok(DOCUMENTS.length >= 20, `${DOCUMENTS.length} documents`);
  const differ = new Set<string>();
  for (const file of DOCUMENTS) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
    const texts = Object.fromEntries(Object.entries(VARIANTS).map(([k, line]) => [k, withVersionLine(text, line)]));
    assert.deepEqual([specVersion(texts.v1), specVersion(texts.none), specVersion(texts.v2)], [1, 1, 2], file);
    for (const [name, read] of Object.entries(READERS)) {
      const v1 = stable(read(texts.v1));
      assert.equal(stable(read(texts.none)), v1, `${name}: ${file} without an smd key`);
      if (stable(read(texts.v2)) !== v1) differ.add(path.basename(file));
    }
  }
  assert.deepEqual([...differ].sort((a, b) => a.localeCompare(b)), [...USES_V2_RULES].sort((a, b) => a.localeCompare(b)));
});

test('corpus/spec-v2.smd reads as the same document with smd: 1, apart from the version itself', () => {
  const v2 = fs.readFileSync(path.join(root, 'extension', 'test', 'compat', 'corpus', 'spec-v2.smd'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(specVersion(v2), 2);
  assert.equal(renderSmd(v2).spec, 2);
  assert.equal(parseSmd(v2).spec, 2);
  assert.equal(indexEntry(v2, 'spec-v2.smd').smd, 2);
  const v1 = v2.replace('\nsmd: 2\n', '\nsmd: 1\n');
  assert.notEqual(v1, v2);
  assert.deepEqual(validateSmd(v2, { today }), [], 'smd: 2 is a supported version: no diagnostics');
  for (const [name, read] of Object.entries(READERS)) assert.equal(stable(read(v2)), stable(read(v1)), name);
  // Raw outputs too, where the version doesn't appear: the HTML, the agent view and the Markdown.
  assert.equal(renderSmd(v2, { today }).html, renderSmd(v1, { today }).html);
  assert.equal(agentView(v2, { today }).text, agentView(v1, { today }).text);
  assert.equal(smdToMarkdown(v2).replace('smd: 2', 'smd: 1'), smdToMarkdown(v1));
});
