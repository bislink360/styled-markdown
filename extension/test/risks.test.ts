import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  documentRisks, renderRiskPage, riskBand, riskMatrixHtml, riskMatrixText, riskRegister, riskRegisterHtml, riskRegisterSummary,
  riskRegisterText, riskScore, riskSummary, renderSmd, agentView, smdToMarkdown, validateSmd, querySmd, formatSmd, outline,
} from '../src/core';

const plan = [
  '---', 'title: Plan', '---', '# Plan', '',
  '## Launch', '',
  ':::risk{impact=critical likelihood=high owner=@ops status=open} Data loss', 'Mitigation: snapshot first. Then drill.', ':::', '',
  ':::risk{impact=low likelihood=critical owner="@maya @li" status=accepted} Flaky CI', '- Retries are cheap. More text.', ':::', '',
  ':::risk Unscored', 'Nobody looked yet', ':::', '',
  '## Old', '',
  ':::risk{impact=high likelihood=high status=closed} Vendor lock-in', 'Closed.', ':::', '',
  '```md', ':::risk{impact=critical likelihood=critical} Not a risk', '```', '',
].join('\n');

const other = [
  '# Other', '',
  '::::risk{impact=medium likelihood=medium status=mitigated owner=@maya #rate} Rate limits',
  ':::warning Pre-warm', 'Ask for a quota.', ':::', '::::', '',
  ':::risk{impact=severe likelihood=medium} Typo in impact', 'x', ':::',
].join('\n');

const docs = [{ path: 'b/plan.smd', text: plan }, { path: 'a/other.smd', text: other }];
const titles = (options = {}) => riskRegister(docs, options).risks.map((r) => r.title);

test('riskScore multiplies the ranks; unknown levels rank as medium', () => {
  assert.equal(riskScore('critical', 'critical'), 16);
  assert.equal(riskScore('high', 'medium'), 6);
  assert.equal(riskScore('low', 'low'), 1);
  assert.equal(riskScore('severe', 'HIGH'), 6);
});

test('documentRisks reads attributes as written and applies defaults', () => {
  const risks = documentRisks(plan, 'plan.smd');
  assert.deepEqual(risks.map((r) => r.title), ['Data loss', 'Flaky CI', 'Unscored', 'Vendor lock-in']);
  const [loss, ci, unscored] = risks;
  assert.deepEqual([loss.impact, loss.likelihood, loss.score, loss.owner, loss.status, loss.section, loss.line], ['critical', 'high', 12, '@ops', 'open', 'Launch', 7]);
  assert.deepEqual(loss.defaulted, []);
  assert.equal(ci.owner, '@maya @li');
  assert.deepEqual([unscored.impact, unscored.likelihood, unscored.score, unscored.status, unscored.owner], ['medium', 'medium', 4, 'open', null]);
  assert.deepEqual(unscored.defaulted, ['impact', 'likelihood']);
  const typo = documentRisks(other).find((r) => r.title === 'Typo in impact')!;
  assert.deepEqual([typo.impact, typo.defaulted], ['medium', ['impact']]);
  assert.equal(documentRisks(other)[0].id, 'rate');
});

test('summaries prefer a Mitigation line, else the first sentence, skipping tags', () => {
  const [loss, ci, unscored] = documentRisks(plan);
  assert.equal(loss.summary, 'Mitigation: snapshot first. Then drill.');
  assert.equal(ci.summary, 'Retries are cheap.');
  assert.equal(unscored.summary, 'Nobody looked yet');
  assert.equal(documentRisks(other)[0].summary, 'Ask for a quota.');
  assert.equal(riskSummary('<risk>\n' + 'word '.repeat(60) + '\n</risk>').length, 160);
});

test('the register sorts by score, then impact, then path and line', () => {
  // Flaky CI (low × critical = 4) and Unscored (medium × medium = 4): the higher impact comes first.
  assert.deepEqual(titles(), ['Data loss', 'Rate limits', 'Typo in impact', 'Unscored', 'Flaky CI']);
  const tie = riskRegister([{ path: 'z.smd', text: plan }, { path: 'a.smd', text: plan }]).risks.slice(0, 2);
  assert.deepEqual(tie.map((r) => r.path), ['a.smd', 'z.smd']);
});

test('filters: closed left out by default, --all, --status and --owner', () => {
  assert.ok(!titles().includes('Vendor lock-in'));
  assert.equal(titles({ all: true })[0], 'Data loss');
  assert.ok(titles({ all: true }).includes('Vendor lock-in'));
  assert.deepEqual(titles({ status: ['closed'] }), ['Vendor lock-in']);
  assert.deepEqual(titles({ status: ['accepted', 'MITIGATED'] }), ['Rate limits', 'Flaky CI']);
  assert.deepEqual(titles({ owner: 'maya' }), ['Rate limits', 'Flaky CI']);
  assert.deepEqual(titles({ owner: '@OPS' }), ['Data loss']);
});

test('matrix counts: impact rows (critical first) × likelihood columns (low first)', () => {
  const register = riskRegister(docs);
  assert.deepEqual(register.matrix.impact, ['critical', 'high', 'medium', 'low']);
  assert.deepEqual(register.matrix.likelihood, ['low', 'medium', 'high', 'critical']);
  assert.deepEqual(register.matrix.counts, [[0, 0, 1, 0], [0, 0, 0, 0], [0, 3, 0, 0], [0, 0, 0, 1]]);
  assert.equal(register.documents, 2);
  assert.equal(register.documentsWithRisks, 2);
  const text = riskMatrixText(register.matrix).split('\n');
  assert.match(text[0], /^impact ↓ likelihood →\s+low\s+medium\s+high\s+critical$/);
  assert.match(text[3], /^medium\s+·\s+3\s+·\s+·$/);
});

test('text output: one line per risk, defaulted levels marked, then the matrix', () => {
  const text = riskRegisterText(riskRegister(docs));
  const lines = text.split('\n');
  assert.equal(lines[0], 'b/plan.smd:8  [12] critical×high  Data loss  @ops  open  — Launch  → Mitigation: snapshot first. Then drill.');
  assert.match(text, /\[4\] medium\?×medium\?  Unscored  open/);
  assert.match(text, /\n\nimpact ↓ likelihood →/);
  assert.equal(riskRegisterText(riskRegister([{ path: 'x.smd', text: '# Empty' }])), '');
  assert.equal(riskRegisterSummary(riskRegister(docs)), '5 risk(s) in 2 of 2 file(s), closed ones left out (--all includes them).');
  assert.equal(riskRegisterSummary(riskRegister(docs, { all: true }), { all: true }), '6 risk(s) in 2 of 2 file(s).');
});

test('score bands colour the matrix green to red', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 8, 9, 12, 16].map(riskBand), ['low', 'low', 'moderate', 'moderate', 'high', 'high', 'severe', 'severe', 'severe']);
});

test('HTML escapes document text and links matrix cells to register rows', () => {
  const evil = ':::risk{impact=high likelihood=high owner="<b>x</b>"} Steal <script>alert(1)</script> & co\nMitigation: <img src=x onerror=alert(1)>\n:::';
  const register = riskRegister([{ path: 'docs/<evil>.smd', text: evil }]);
  const html = riskRegisterHtml(register);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>x'));
  assert.ok(html.includes('Steal &lt;script&gt;alert(1)&lt;/script&gt; &amp; co'));
  assert.ok(html.includes('docs/&lt;evil&gt;.smd:1'));
  assert.ok(html.includes('<a href="#risk-1">'));
  assert.ok(html.includes('<tr id="risk-1">'));
  assert.match(html, /class="smd-risk-cell smd-risk-band-severe" data-score="9"/);
  const page = renderRiskPage(register);
  assert.match(page, /^<!DOCTYPE html>/);
  assert.ok(page.includes('data-smd-theme-pref="auto"'));
  assert.ok(page.includes('<title>Risk register</title>'));
  assert.ok(!page.includes('mermaid.min.js'));
  const plain = riskMatrixHtml(register.matrix, register.risks);
  assert.ok(plain.includes('<span>Steal &lt;script&gt;'));
  assert.ok(riskRegisterHtml(riskRegister([])).includes('No risks found.'));
});

const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd risks prints the register, JSON and HTML, and rejects unknown statuses', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const examples = join(__dirname, '..', '..', 'examples');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'risks', examples, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const text = run();
  assert.match(text, /checkout-redesign\.smd:\d+  \[6\] high×medium  Apple Pay domain verification delays launch/);
  assert.match(text, /impact ↓ likelihood →/);
  const json = JSON.parse(run('--json', '--status', 'mitigated'));
  assert.deepEqual(json.risks.map((r: { status: string }) => r.status), ['mitigated']);
  assert.equal(json.matrix.counts.length, 4);
  const owned = JSON.parse(run('--json', '--owner', '@payments'));
  assert.ok(owned.risks.length >= 1 && owned.risks.every((r: { owner: string }) => r.owner === '@payments'));
  assert.match(run('--html'), /<table class="smd-risk-matrix-grid">/);
  const bad = spawnSync(process.execPath, [cli, 'risks', examples, '--status', 'done'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown risk status "done"/);
});

const withMatrix = [
  '# Launch', '',
  ':::risk{#loss impact=critical likelihood=high} Data <b>loss</b>', 'Snapshot first.', ':::', '',
  ':::risk{impact=low likelihood=low status=closed} Old', 'Done.', ':::', '',
  ':::risk-matrix Launch risks', ':::', '',
].join('\n');

test(':::risk-matrix renders a matrix of the document\'s open risks', () => {
  const html = renderSmd(withMatrix, { today: '2026-09-01' }).html;
  assert.match(html, /<div class="smd-risk-matrix" data-line="10"><div class="smd-risk-matrix-title">Launch risks<\/div>/);
  assert.ok(html.includes('<a href="#loss">Data &lt;b&gt;loss&lt;/b&gt;</a>'));
  assert.ok(!html.slice(html.indexOf('smd-risk-matrix-grid')).includes('>Old<'));
  assert.ok(html.includes('<div class="smd-risk-matrix-body">'));
});

test(':::risk-matrix in the agent view, plain Markdown, validation and query', () => {
  const view = agentView(withMatrix).text;
  assert.ok(view.includes('[risk matrix: Launch risks — impact × likelihood of this document\'s risks except closed ones; each is a <risk> block]'));
  const md = smdToMarkdown(withMatrix);
  assert.ok(md.includes('**Risk matrix: Launch risks**'));
  assert.ok(md.includes('| **Critical** |  |  | Data <b>loss</b> |  |'));
  assert.ok(!md.includes(':::risk-matrix'));
  assert.deepEqual(validateSmd(withMatrix).filter((d) => d.severity !== 'hint' && d.severity !== 'info'), []);
  assert.deepEqual(querySmd(withMatrix, 'risk-matrix').map((m) => m.title), ['Launch risks']);
  assert.equal(formatSmd(withMatrix), withMatrix);
  // The outline flags sections with risks, not sections with only a matrix.
  assert.doesNotMatch(outline('# A\n\n## Matrix\n\n:::risk-matrix\n:::\n'), /Matrix.*risk/);
});
