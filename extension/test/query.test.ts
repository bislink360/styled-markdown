import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSelector, querySmd, SelectorError } from '../src/core';

const doc = [
  '---', 'title: Plan', '---', '# Plan', '',
  '## Decisions', '',
  ':::decision{status=accepted date=2026-09-12 owner=@maya} Launch in the EU first', 'Smaller market first.', ':::', '',
  ':::decision Keep the monolith', 'Pending.', ':::', '',
  '## Risks', '',
  '::::risk{impact=high likelihood=low owner=@ops} Rate limits', ':::warning Pre-warm', 'Ask for a quota.', ':::', '::::', '',
  ':::risk{impact=critical status=closed} Data loss', 'Backups.', ':::', '',
  ':::risk Minor', 'x', ':::', '',
  '## API', '',
  ':::api{method=post path="/v1/orders"} Create an order', 'Body.', ':::', '',
  ':::question Who owns billing?', 'Open.', ':::', '',
  '```md', ':::decision{status=accepted} Not a decision', '```', '',
  '## Tasks', '',
  '- [ ] Ship it @maya @li :priority[P0] :due[2026-10-01]',
  '- [x] Draft @maya :priority[high]',
  '- [ ] Later :priority[P3] :due[2026-12-01]',
  '',
].join('\n');

const titles = (selector: string, today = '2026-09-01') => querySmd(doc, selector, { today }).map((m) => m.title);

test('parseSelector reads types, operators, alternatives and quoted values', () => {
  assert.deepEqual(parseSelector(' decision[status=accepted|Proposed] , risk[impact >= high][owner]'), [
    { type: 'decision', tests: [{ key: 'status', op: '=', values: ['accepted', 'Proposed'] }] },
    { type: 'risk', tests: [{ key: 'impact', op: '>=', values: ['high'] }, { key: 'owner', op: 'exists', values: [] }] },
  ]);
  assert.deepEqual(parseSelector('[owner=@maya]'), [{ type: '*', tests: [{ key: 'owner', op: '=', values: ['@maya'] }] }]);
  assert.deepEqual(parseSelector('card[title="a ] b"|\'c\']'), [{ type: 'card', tests: [{ key: 'title', op: '=', values: ['a ] b', 'c'] }] }]);
  assert.deepEqual(parseSelector('Task[due<today]')[0].type, 'task');
});

test('parseSelector says what is wrong, with a suggestion', () => {
  const fails = (src: string, message: RegExp) => assert.throws(() => parseSelector(src), (e: Error) => e instanceof SelectorError && message.test(e.message));
  fails('', /Empty selector/);
  fails('decison', /Unknown block type "decison"\. Did you mean "decision"\?/);
  fails('decision[stauts=accepted]', /"decision" has no attribute "stauts"\. Did you mean "status"\?/);
  fails('task[impact=high]', /"task" has no attribute "impact"/);
  fails('risk[impact>=]', /Missing value after ">="/);
  fails('risk[impact<high|low]', /"<" takes one value/);
  fails('risk[impact=high', /Missing "\]"/);
  fails('card[title="x]', /Missing closing "/);
  fails('decision risk', /List several selectors with commas/);
  fails('decision,', /Missing a selector after ","/);
  fails('risk[=high]', /Expected an attribute name/);
  // Any key is allowed on * (containers may carry custom attributes).
  assert.equal(parseSelector('*[anything]').length, 1);
});

test('querySmd selects containers by type and attributes, with spec defaults', () => {
  assert.deepEqual(titles('decision'), ['Launch in the EU first', 'Keep the monolith']); // not the one in code
  assert.deepEqual(titles('decision[status=proposed]'), ['Keep the monolith']);
  assert.deepEqual(titles('risk[impact=medium]'), ['Minor']);
  assert.deepEqual(titles('risk[impact>=high]'), ['Rate limits', 'Data loss']);
  assert.deepEqual(titles('risk[impact>=high][status!=closed]'), ['Rate limits']);
  assert.deepEqual(titles('risk[likelihood]'), ['Rate limits']);
  assert.deepEqual(titles('api[method=POST]'), ['Create an order']);
  assert.deepEqual(titles('api[path^=/v1/]'), ['Create an order']);
  assert.deepEqual(titles('callout'), ['Pre-warm', 'Who owns billing?']);
  assert.deepEqual(titles('decision[title*=EU], decision[section=decisions]'), ['Launch in the EU first', 'Keep the monolith']);
  assert.deepEqual(titles('question, decision[status=accepted]'), ['Launch in the EU first', 'Who owns billing?']);
  assert.deepEqual(titles('*[owner=@maya]'), ['Launch in the EU first', 'Ship it', 'Draft']);
});

test('querySmd reports lines, attributes, sections and the agent view of each match', () => {
  const [risk] = querySmd(doc, 'risk[impact=high]');
  assert.deepEqual({ ...risk, text: undefined }, {
    type: 'risk', line: 17, endLine: 21, title: 'Rate limits', section: 'Risks', text: undefined,
    attrs: { impact: 'high', likelihood: 'low', owner: '@ops' },
  });
  assert.equal(risk.text, '<risk impact="high" likelihood="low" owner="@ops"> Rate limits\n<warning title="Pre-warm">\nAsk for a quota.\n</warning>\n</risk>');
  const [warning] = querySmd(doc, 'warning');
  assert.deepEqual([warning.line, warning.endLine, warning.section], [18, 20, 'Risks']);
  assert.equal(querySmd(doc, 'api')[0].attrs.method, 'POST');
});

test('querySmd selects tasks by owner, priority, due date and state', () => {
  assert.deepEqual(titles('task[owner=li]'), ['Ship it']);
  assert.deepEqual(titles('task[done=false]'), ['Ship it', 'Later']);
  assert.deepEqual(titles('task[priority<=P1]'), ['Ship it', 'Draft']); // high counts as P1
  assert.deepEqual(titles('task[due<today]', '2026-11-01'), ['Ship it']);
  assert.deepEqual(titles('task[overdue]', '2026-11-01'), ['Ship it']);
  assert.deepEqual(titles('task[due>=2026-10-01]'), ['Ship it', 'Later']);
  const [ship] = querySmd(doc, 'task[priority=P0]', { today: '2026-09-01' });
  assert.deepEqual(ship.attrs, { done: 'false', overdue: 'false', owner: ['@maya', '@li'], priority: 'P0', due: '2026-10-01' });
  assert.deepEqual([ship.line, ship.endLine, ship.section], [47, 47, 'Tasks']);
});

test('querySmd selects headings with their whole section', () => {
  assert.deepEqual(titles('heading[level=2]'), ['Decisions', 'Risks', 'API', 'Tasks']);
  assert.deepEqual(titles('heading[section=plan][id^=r]'), ['Risks']);
  const [risks] = querySmd(doc, 'heading[id=risks]', { lineRefs: false });
  assert.deepEqual([risks.line, risks.endLine, risks.attrs], [15, 30, { level: '2', id: 'risks' }]);
  assert.match(risks.text, /^## Risks\n\n<risk impact="high"[^]*Minor\nx\n<\/risk>$/);
  assert.deepEqual(querySmd(doc, 'decision[status=superseded]'), []);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd query prints matches and exits 1 when nothing matches', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const examples = join(__dirname, '..', '..', 'examples');
  const out = execFileSync(process.execPath, [cli, 'query', 'risk[impact>=high]', examples, '--titles'], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /checkout-redesign\.smd:\d+-\d+ {2}risk {2}Apple Pay domain verification delays launch {2}\{impact=high /);
  const json = JSON.parse(execFileSync(process.execPath, [cli, 'query', 'api[method=POST]', examples, '--json'], { encoding: 'utf8', stdio: 'pipe' }));
  assert.ok(json.length >= 2 && json.every((m: { type: string; text: string }) => m.type === 'api' && m.text.startsWith('API POST ')));
  assert.equal(spawnSync(process.execPath, [cli, 'query', 'decision[status=deprecated]', examples]).status, 1);
  const bad = spawnSync(process.execPath, [cli, 'query', 'decison', examples], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Did you mean "decision"/);
});
