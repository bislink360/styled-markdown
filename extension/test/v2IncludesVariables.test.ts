import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  agentView, extractTasks, getDocumentInfo, parseSmd, querySmd, renderSmd, smdToConfluence, smdToMarkdown, smdToNotion, validateSmd,
} from '../src/core';
import smd from '../src/core/markdownIt';
import { renderBlocks } from '../src/core/blocks';
import { exportTree, inlineText } from '../src/core/exportTree';
import { parseFrontMatter, sourceSpelledData } from '../src/core/frontmatter';
import { findSection, sectionsOf } from '../src/core/sections';
import { documentVariables, shownValues, variableCompletion, variableHover } from '../src/core/variables';

/**
 * Spec v2 proposals 9 and 10, through every reader, both ways: a document with `smd: 2` gets the v2 rule, the same
 * document with `smd: 1` (or no `smd`) reads exactly as before.
 */

const today = '2026-10-17';
const corpus = path.join(__dirname, 'compat', 'corpus');
const read = (name: string) => fs.readFileSync(path.join(corpus, name), 'utf8').replaceAll('\r\n', '\n');
const asV1 = (text: string) => text.replace(/^smd: 2$/m, 'smd: 1');
const codes = (text: string, options = {}) => validateSmd(text, { today, ...options }).map((d) => `${d.line}:${d.code}:${d.severity}`);

// ---------------------------------------------------------------------------
// Proposal 9: `:::include section=` matches exactly
// ---------------------------------------------------------------------------

const TERMS = '---\nsmd: 1\n---\n\n## Rapid deployment\n\nShip it.\n\n## Deploy {#d1}\n\nThe deploy steps.\n\n## Refunds\n\nWithin 30 days.\n';
const files: Record<string, string> = {
  'terms.smd': TERMS,
  // An included file that includes by a part of a heading: the root document's version decides how it matches.
  'outer.smd': '---\nsmd: 2\n---\n\n## Outer\n\n:::include{file="terms.smd" section="refund"}\nNested fallback.\n:::\n',
};
const readFile = (p: string) => files[p];
const including = (smdLine: string, section: string) => `---\n${smdLine}\n---\n\n## Here\n\n:::include{file="terms.smd" section="${section}"}\nThe fallback.\n:::\n`;

test('findSection: v1 takes an id, then a part of the text; v2 an id, or the whole text in any case', () => {
  const sections = sectionsOf(parseSmd(TERMS).headings, TERMS.split('\n').length);
  const found = (q: string, spec?: 1 | 2) => findSection(sections, q, spec)?.heading.text;
  assert.equal(found('deploy'), 'Rapid deployment', 'v1: the first heading whose text contains it');
  assert.equal(found('deploy', 2), 'Deploy', 'v2: the whole text, not a part');
  assert.equal(found('refund'), 'Refunds');
  assert.equal(found('refund', 2), undefined);
  for (const q of ['refunds', '#refunds', 'REFUNDS', '  Refunds ', 'd1', 'rapid-deployment', 'Rapid Deployment']) assert.ok(found(q, 2), q);
  assert.equal(found('d1', 2), 'Deploy', 'a custom id');
});

test('render: a v2 include finds an exact id or heading text; a part of it is a missing section with its fallback, as v1 shows one', () => {
  const v2 = (section: string) => renderSmd(including('smd: 2', section), { readFile, today }).html;
  const v1 = (section: string) => renderSmd(including('smd: 1', section), { readFile, today }).html;
  assert.match(v2('REFUNDS'), /Within 30 days/);
  assert.match(v2('#refunds'), /Within 30 days/);
  assert.match(v1('refund'), /Within 30 days/);
  assert.doesNotMatch(v2('refund'), /Within 30 days/);
  assert.match(v2('refund'), /The fallback/);
  // What v2 shows for a part of a heading is exactly what v1 shows for a section that isn't there.
  assert.equal(v2('refund'), v1('nowhere').replaceAll('nowhere', 'refund'));
  assert.match(v1('deploy'), /Ship it/);
  assert.match(v2('deploy'), /The deploy steps/);
  // Without an smd key the document is v1, unless the host's spec option says v2.
  const none = including('title: T', 'refund');
  assert.match(renderSmd(none, { readFile, today }).html, /Within 30 days/);
  assert.doesNotMatch(renderSmd(none, { readFile, today, spec: 2 }).html, /Within 30 days/);
});

test('render: nested includes match with the root document\'s version, whatever the included file says', () => {
  const root = (smdLine: string) => `---\n${smdLine}\n---\n\n:::include{file="outer.smd"}\n:::\n`;
  assert.match(renderSmd(root('smd: 1'), { readFile, today }).html, /Within 30 days/);
  const v2 = renderSmd(root('smd: 2'), { readFile, today }).html;
  assert.match(v2, /Outer/);
  assert.doesNotMatch(v2, /Within 30 days/);
  assert.match(v2, /Nested fallback/);
});

test('markdown-it plugin: sections match by the document\'s version, or the spec option', () => {
  const md = new MarkdownIt().use(smd, { readFile: (p: string) => files[p] });
  assert.match(md.render(including('smd: 1', 'refund')), /Within 30 days/);
  assert.doesNotMatch(md.render(including('smd: 2', 'refund')), /Within 30 days/);
  const host = new MarkdownIt().use(smd, { readFile: (p: string) => files[p], spec: 2 });
  assert.doesNotMatch(host.render(':::include{file="terms.smd" section="refund"}\n:::\n'), /Within 30 days/);
  assert.match(host.render(':::include{file="terms.smd" section="Refunds"}\n:::\n'), /Within 30 days/);
});

test('agent view, to-md, Block Editor and exporters: a v2 include does not match a part of a heading', () => {
  const v1 = including('smd: 1', 'refund');
  const v2 = including('smd: 2', 'refund');
  assert.match(agentView(v1, { readFile, today }).text, /<included file="terms.smd" section="refund">/);
  assert.match(agentView(v2, { readFile, today }).text, /\[include: terms\.smd § refund — no section "refund" in the file\]/);
  assert.match(smdToMarkdown(v1, { readFile }), /Within 30 days/);
  assert.doesNotMatch(smdToMarkdown(v2, { readFile }), /Within 30 days/);
  assert.match(smdToMarkdown(v2, { readFile }), /The fallback/);
  const blocks = (text: string) => renderBlocks(text, { readFile, today }).blocks.map((b) => b.html).join('');
  assert.match(blocks(v1), /Within 30 days/);
  assert.doesNotMatch(blocks(v2), /Within 30 days/);
  assert.match(smdToConfluence(v1, { readFile }), /Within 30 days/);
  assert.doesNotMatch(smdToConfluence(v2, { readFile }), /Within 30 days/);
  assert.match(JSON.stringify(smdToNotion(v1, { readFile })), /Within 30 days/);
  assert.doesNotMatch(JSON.stringify(smdToNotion(v2, { readFile })), /Within 30 days/);
});

test('validate: v1 reports a part of a heading as the info include/section-match; v2 as the warning include/missing-section', () => {
  assert.deepEqual(codes(including('smd: 1', 'refund'), { readFile }), ['6:include/section-match:info']);
  assert.deepEqual(codes(including('smd: 2', 'refund'), { readFile }), ['6:include/missing-section:warning']);
  assert.deepEqual(codes(including('smd: 2', 'Refunds'), { readFile }), []);
  assert.deepEqual(codes(including('smd: 2', 'refunds'), { readFile }), []);
});

test('smd agent --section keeps matching a part of a heading in a v2 document: it is for people typing', () => {
  const view = agentView(`---\nsmd: 2\n---\n\n${TERMS.split('---\n')[2]}`, { sections: ['deploy'], today });
  assert.match(view.text, /Rapid deployment/);
  assert.deepEqual(view.missingSections, []);
});

test('corpus/v2-includes.smd: v2 includes the exact sections and shows the fallback for a part; with smd: 1 it includes all three', () => {
  const text = read('v2-includes.smd');
  const reader = (p: string) => (fs.existsSync(path.join(corpus, p)) ? read(p) : undefined);
  const v2 = renderSmd(text, { readFile: reader, today }).html;
  assert.match(v2, /Plans are billed monthly/);
  assert.equal(v2.match(/Refunds within 30 days/g)?.length, 1, 'only the id include');
  assert.match(v2, /The refund policy is in/);
  assert.deepEqual(validateSmd(text, { readFile: reader, today }), [], 'the missing section is suppressed');
  const v1 = renderSmd(asV1(text), { readFile: reader, today }).html;
  assert.equal(v1.match(/Refunds within 30 days/g)?.length, 2);
  assert.deepEqual(codes(asV1(text), { readFile: reader }).map((c) => c.split(':')[1]), ['include/section-match']);
});

// ---------------------------------------------------------------------------
// Proposal 10: variables keep their YAML spelling
// ---------------------------------------------------------------------------

const FRONT = [
  'title: T', 'status: draft', 'version: 2.10', 'updated: 2026-10-05', 'owners: ["@a"]', 'tags: [docs, 1.10, true]', 'build: 007', 'flag: True',
  'quoted: "3.10"', 'single: \'4.10\'', 'block: |\n  5.10', 'hex: 0x1F', 'big: 1e3', 'none: null', 'release:\n  number: 4.0',
].join('\n');
const BODY = '## In {{version}}\n\nV {{version}} b {{build}} f {{flag}} q {{quoted}} s {{single}} k {{block}} h {{hex}} e {{big}} r {{release.number}} t {{tags}} u {{updated}} n {{none}}.\n\n- [ ] Ship {{version}} :due[2026-11-02]\n\n:::note Upgrade to {{version}}\nx\n:::\n';
const variablesDoc = (smdLine: string) => `---\n${smdLine}\n${FRONT}\n---\n\n${BODY}`;
// A block scalar keeps its line break, shown as a space (as in v1).
const V1_LINE = 'V 2.1 b 7 f true q 3.10 s 4.10 k 5.10  h 31 e 1000 r 4 t docs, 1.1, true u 2026-10-05 n {{none}}.';
const V2_LINE = 'V 2.10 b 007 f True q 3.10 s 4.10 k 5.10  h 0x1F e 1e3 r 4.0 t docs, 1.10, true u 2026-10-05 n {{none}}.';

test('sourceSpelledData: plain numbers and booleans as written; quoted, block, date and null values as YAML reads them', () => {
  const data = sourceSpelledData(variablesDoc('smd: 2'));
  assert.deepEqual(data, {
    smd: '2', title: 'T', status: 'draft', version: '2.10', updated: '2026-10-05', owners: ['@a'], tags: ['docs', '1.10', 'true'], build: '007',
    flag: 'True', quoted: '3.10', single: '4.10', block: '5.10\n', hex: '0x1F', big: '1e3', none: null, release: { number: '4.0' },
  });
  assert.equal(sourceSpelledData('# No front matter'), undefined);
  assert.equal(sourceSpelledData('---\n: : bad\n---\n'), undefined);
});

test('shownValues: the parsed data itself in v1, without front matter source, or when it does not parse', () => {
  const text = variablesDoc('smd: 1');
  const data = parseFrontMatter(text).data;
  assert.equal(shownValues(data, text, 1), data);
  assert.equal(shownValues(data, undefined, 2), data);
  assert.equal(shownValues(data, '# body only', 2), data);
  assert.equal(shownValues(data, text, 2).version, '2.10');
  // Dates are strings under the CORE schema already: the same in both versions.
  assert.equal(shownValues(data, text, 2).updated, data.updated);
});

test('render: {{key}} and the header keep the source spelling in v2; v1 is unchanged', () => {
  const v1 = renderSmd(variablesDoc('smd: 1'), { today }).html;
  const v2 = renderSmd(variablesDoc('smd: 2'), { today }).html;
  assert.ok(v1.includes(`>${V1_LINE}</p>`), v1);
  assert.ok(v2.includes(`>${V2_LINE}</p>`), v2);
  assert.match(v1, /<span>v2\.1<\/span>/);
  assert.match(v2, /<span>v2\.10<\/span>/);
  assert.match(v1, /<span class="smd-tag">1\.1<\/span>/);
  assert.match(v2, /<span class="smd-tag">1\.10<\/span>/);
  assert.match(v2, /Updated 2026-10-05/);
  assert.match(v2, /<h2 id="in-version"[^>]*>In 2\.10<\/h2>/, 'the heading id comes from the source either way');
  assert.match(v2, /Upgrade to 2\.10/);
  // No front matter key: the same document without smd is v1.
  assert.equal(renderSmd(variablesDoc('#smd: 2'), { today }).html, renderSmd(variablesDoc('#smd: 1'), { today }).html);
});

test('markdown-it plugin: variables and the front matter header keep the source spelling in v2', () => {
  const md = new MarkdownIt().use(smd, { frontMatter: true });
  const v1 = md.render(variablesDoc('smd: 1'));
  const v2 = md.render(variablesDoc('smd: 2'));
  assert.ok(v1.includes(V1_LINE) && v2.includes(V2_LINE));
  assert.match(v1, /<span>v2\.1<\/span>/);
  assert.match(v2, /<span>v2\.10<\/span>/);
  // A host that removed the front matter passes its data, which has no source spelling: shown as parsed.
  assert.equal(new MarkdownIt().use(smd).render('V {{version}}.', { smdVariables: { smd: 2, version: 2.1 } }), '<p>V 2.1.</p>\n');
});

test('agent view, outline, to-md, tasks, query and meta: v2 spelling; v1 unchanged', () => {
  for (const [smdLine, line, version] of [['smd: 1', V1_LINE, '2.1'], ['smd: 2', V2_LINE, '2.10']] as const) {
    const text = variablesDoc(smdLine);
    const agent = agentView(text, { today, lineRefs: false }).text;
    assert.ok(agent.includes(line), agent);
    assert.match(agent, new RegExp(`version: ${version.replace('.', String.raw`\.`)} ·`));
    assert.ok(smdToMarkdown(text).includes(line));
    assert.equal(extractTasks(text, today)[0].text, `Ship ${version}`);
    assert.equal(extractTasks(text, today)[0].section, `In ${version}`);
    assert.equal(querySmd(text, 'note', { today })[0].title, `Upgrade to ${version}`);
    assert.equal(getDocumentInfo(text, { today }).outline[0].text, `In ${version}`);
    assert.equal(parseSmd(text).headings[0].text, `In ${version}`);
  }
});

test('exporters and the Block Editor: header facts and {{key}} keep the source spelling in v2', () => {
  for (const [smdLine, line, version] of [['smd: 1', V1_LINE, '2.1'], ['smd: 2', V2_LINE, '2.10']] as const) {
    const text = variablesDoc(smdLine);
    const tree = exportTree(text);
    const plain = tree.blocks.map((b) => ('content' in b ? inlineText(b.content as never) : JSON.stringify(b))).join('\n');
    assert.ok(plain.includes(`v${version}`), plain);
    assert.ok(plain.includes(line), plain);
    assert.ok(smdToConfluence(text).includes(line));
    assert.ok(renderBlocks(text, { today }).blocks.some((b) => b.html.includes(line)));
  }
});

test('documentVariables, hover and completion: the values a document shows', () => {
  const v2 = variablesDoc('smd: 2');
  assert.equal(documentVariables(v2.split('\n')).version, '2.10');
  assert.equal(documentVariables(variablesDoc('smd: 1').split('\n')).version, 2.1);
  const at = v2.split('\n').findIndex((l) => l.startsWith('V {{version}}'));
  assert.match(variableHover(v2, at, 4)?.markdown ?? '', /`2\.10`/);
  assert.match(variableHover(variablesDoc('smd: 1'), at, 4)?.markdown ?? '', /`2\.1`/);
  const typing = `${v2}{{`;
  assert.equal(variableCompletion(typing, typing.split('\n').length - 1, 2)?.names.find((n) => n.name === 'version')?.text, '2.10');
});

test('validate: a v2 document with plain numbers is valid, and the variable codes are the same in both versions', () => {
  assert.deepEqual(codes(variablesDoc('smd: 2')), codes(variablesDoc('smd: 1')));
});

test('corpus/v2-variables.smd: shows its values as written; with smd: 1 as YAML reads them', () => {
  const text = read('v2-variables.smd');
  const v2 = renderSmd(text, { today }).html;
  assert.match(v2, /Version 2\.10 \(“Juniper”, release 4\.0\) is build 007, updated 2026-10-05\./);
  assert.match(v2, /Ratio 1\.50, beta True, quoted 3\.10, tags release, 1\.10\./);
  assert.match(v2, /<span>v2\.10<\/span>/);
  const v1 = renderSmd(asV1(text), { today }).html;
  assert.match(v1, /Version 2\.1 \(“Juniper”, release 4\) is build 7, updated 2026-10-05\./);
  assert.match(v1, /Ratio 1\.5, beta true, quoted 3\.10, tags release, 1\.1\./);
  assert.deepEqual(validateSmd(text, { today }), []);
});
