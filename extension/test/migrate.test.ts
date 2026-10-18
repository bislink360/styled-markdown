import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatSmd, renderSmd, validateSmd } from '../src/core';
import { KIND_ORDER, migrationKind, migrationPlan, type MigrationKind, type MigrationOptions, type MigrationPlan } from '../src/core/migrate';
import { migrationReport, migrationSummary } from '../src/migrateReport';

/**
 * `smd migrate --to 2 --dry-run` (1.10, spec v2 RFC "Rollout and migration"): the plan that keeps each document's
 * meaning under spec v2. Steps marked `keeps: 'v1'` leave the v1 rendering as it is; the others keep the v2 meaning.
 */

const TODAY = '2026-10-15';
const doc = (body: string, smd = 'smd: 1') => `---\n${smd}\n---\n\n${body}\n`;
const plan = (text: string, options: MigrationOptions = {}) => migrationPlan(text, options);
const changes = (p: MigrationPlan, kind?: MigrationKind) => p.steps.filter((s) => !s.note && (!kind || s.kind === kind));
const notes = (p: MigrationPlan, kind?: MigrationKind) => p.steps.filter((s) => s.note && (!kind || s.kind === kind));
/** The steps of a kind as `line:before→after`, lines 1-based. */
const edits = (p: MigrationPlan, kind: MigrationKind) => changes(p, kind).map((s) => `${s.line + 1}:${s.before}→${s.after}`);
/**
 * HTML without what moves with the source lines (`data-line`) or names the include's query (`data-include`), and
 * with each class once: v1 writes a repeated class twice, which collapsing duplicate attributes leaves out.
 */
const comparable = (html: string) => html
  .replaceAll(/ data-line="\d+"/g, '').replaceAll(/ data-include="[^"]*"/g, '')
  .replaceAll(/ class="([^"]*)"/g, (_, names: string) => ` class="${[...new Set(names.split(' '))].join(' ')}"`);
/** The document read with the v1 rules, as tools before 2.0 read a migrated `smd: 2` document (comparable HTML). */
const v1 = (text: string, options: MigrationOptions = {}) =>
  comparable(renderSmd(text.replace(/^smd: 2(\r?)$/m, 'smd: 1$1'), { readFile: options.readFile, today: TODAY }).html);
/** The document read with its own version's rules: a migrated document with the v2 rules (comparable HTML). */
const asIs = (text: string, options: MigrationOptions = {}) => comparable(renderSmd(text, { readFile: options.readFile, today: TODAY }).html);
const crlf = (s: string) => s.replaceAll('\n', '\r\n');

/** The checks every case gets: v1 rendering kept (when asked), the same plan with CRLF, and nothing left to do. */
function checkCase(text: string, options: MigrationOptions = {}, keepsV1 = true): MigrationPlan {
  const p = plan(text, options);
  if (keepsV1) assert.equal(v1(p.result, options), v1(text, options), 'the v1 rendering is kept');
  const windows = plan(crlf(text), options);
  assert.equal(windows.result, crlf(p.result), 'CRLF documents migrate the same, and keep CRLF');
  assert.deepEqual(windows.steps, p.steps);
  const again = plan(p.result, { ...options, force: true });
  assert.deepEqual(changes(again), [], 'the plan of the result has nothing left to change');
  return p;
}

// ---------------------------------------------------------------------------
// 1. Closing fences (proposal 3)
// ---------------------------------------------------------------------------

test('migrate: closing fences get their container\'s colon count', () => {
  const p = checkCase(doc('::::tabs\n:::tab A\nOne\n::::\n:::tab B\nTwo\n:::\n:::'));
  assert.deepEqual(edits(p, 'closer'), ['8:::::→:::', '12::::→::::']);
  assert.match(p.result, /One\n:::\n:::tab B\nTwo\n:::\n::::\n$/);
  assert.equal(changes(p, 'closer')[0].proposal, '3');
  assert.equal(changes(p, 'closer')[0].keeps, 'v1');
});

test('migrate: matching closers, and fences in code or math, are left alone', () => {
  for (const body of ['::::tabs\n:::tab A\nOne\n:::\n::::', '```\n::::note\nx\n:::\n```', ':::note\n$$\n::::\n$$\n:::']) {
    assert.deepEqual(changes(checkCase(doc(body)), 'closer'), [], body);
  }
});

test('migrate: a closer is rewritten even where its hint is suppressed', () => {
  const p = checkCase(doc('::::note\nx\n<!-- smd-disable-next-line container/colons -->\n:::'));
  assert.deepEqual(edits(p, 'closer'), ['8::::→::::']);
});

// ---------------------------------------------------------------------------
// 2. Duplicate attributes (proposal 4)
// ---------------------------------------------------------------------------

test('migrate: duplicate attributes are collapsed to the value v1 uses', () => {
  const text = doc('A [span]{color=red color=blue} and :badge[B]{color=red color=green}.\n\n:::note{#a #b} T\nx\n:::\n\n## H {.c .c}');
  const p = checkCase(text);
  assert.deepEqual(edits(p, 'duplicate-attrs'), [
    '5:A [span]{color=red color=blue} and :badge[B]{color=red color=green}.→A [span]{color=blue} and :badge[B]{color=green}.',
    '7::::note{#a #b} T→:::note{#b} T',
    '11:## H {.c .c}→## H {.c}',
  ]);
  // Only a repeated class renders differently: v1 writes it twice (v() reads each class once).
  assert.match(renderSmd(text).html, /<h2 class="smd-u-c smd-u-c" id="h"/);
  assert.match(renderSmd(p.result).html, /<h2 class="smd-u-c" id="h"/);
});

test('migrate: attribute lists in code are left alone', () => {
  const text = doc('`[x]{color=red color=blue}`\n\n```\n[x]{color=red color=blue}\n```');
  assert.deepEqual(changes(checkCase(text), 'duplicate-attrs'), []);
});

// ---------------------------------------------------------------------------
// 3. Title text that is not shown (proposal 4)
// ---------------------------------------------------------------------------

test('migrate: container title text that title="…" hides is removed', () => {
  const p = checkCase(doc(':::note{title="Shown"} Hidden\nx\n:::\n\n:::note{title="Only"}\ny\n:::\n\n:::warning Plain title\nz\n:::'));
  assert.deepEqual(edits(p, 'title-text'), ['5::::note{title="Shown"} Hidden→:::note{title="Shown"}']);
});

test('migrate: priority on :::agent, removed in 2.0, is removed; other unknown attributes are left alone', () => {
  const p = checkCase(doc(':::agent{priority=high} Read this\nx\n:::\n\n:::agent{title="T" priority=1}\ny\n:::\n\n:::note{colr=red}\nz\n:::'));
  assert.deepEqual(edits(p, 'agent-priority'), ['5::::agent{priority=high} Read this→:::agent Read this', '9::::agent{title="T" priority=1}→:::agent{title="T"}']);
  assert.match(p.result, /:::note\{colr=red\}/);
  assert.equal(migrationKind('agent-priority').proposal, '12');
});

test('migrate: title text next to a comment is a note, not a change', () => {
  const p = checkCase(doc(':::note{title="Shown"} Hidden <!-- smd-disable-line container/title-conflict -->\nx\n:::'));
  assert.deepEqual(changes(p, 'title-text'), []);
  assert.equal(notes(p, 'title-text').length, 1);
  assert.match(notes(p, 'title-text')[0].reason, /^Not rewritten: This title text is not shown/);
});

// ---------------------------------------------------------------------------
// 4. $$ delimiters (proposal 2)
// ---------------------------------------------------------------------------

test('migrate: $$ with math on its line moves onto a line of its own', () => {
  const p = checkCase(doc('$$ a + b\nc\nd $$\n\nText.'));
  assert.deepEqual(changes(p, 'math-delimiters').map((s) => [s.line + 1, s.endLine + 1, s.after]), [[5, 7, '$$\na + b\nc\nd\n$$']]);
  assert.equal(changes(p, 'math-delimiters')[0].keeps, 'v1');
});

test('migrate: $$ splits keep the math in quotes, lists and containers', () => {
  const quoted = checkCase(doc('> $$ x\n> y $$'));
  assert.deepEqual(changes(quoted, 'math-delimiters').map((s) => s.after), ['> $$\n> x\n> y\n> $$']);
  const listed = checkCase(doc('- item\n\n  $$ x\n  y $$\n- next'));
  assert.deepEqual(changes(listed, 'math-delimiters').map((s) => s.after), ['  $$\n  x\n  y\n  $$']);
  const marked = checkCase(doc('- $$ x\n  y $$'));
  assert.deepEqual(changes(marked, 'math-delimiters').map((s) => s.after), ['- $$\n  x\n  y\n  $$']);
  const contained = checkCase(doc(':::note\n$$ x\ny $$\n:::'));
  assert.deepEqual(changes(contained, 'math-delimiters').map((s) => s.line + 1), [6]);
  const opener = checkCase(doc('$$ x\ny\n$$'));
  assert.deepEqual(changes(opener, 'math-delimiters').map((s) => s.after), ['$$\nx\ny\n$$']);
});

test('migrate: own-line and one-line $$, and $$ in code, are left alone', () => {
  for (const body of ['$$\nx\n$$', '$$x + y$$', '```\n$$ x\ny $$\n```', '    $$ x\n    y $$', 'Text with `$$ x` in code.']) {
    assert.deepEqual(changes(checkCase(doc(body)), 'math-delimiters'), [], body);
  }
});

// ---------------------------------------------------------------------------
// 5. Braces after headings (proposal 5)
// ---------------------------------------------------------------------------

test('migrate: an empty {} or a bare {word} after a heading is removed', () => {
  const p = checkCase(doc('## Object {}\n\n## Returns {ok}\n\n## Both {#id ok}'));
  assert.deepEqual(edits(p, 'heading-braces'), ['5:## Object {}→## Object', '7:## Returns {ok}→## Returns', '9:## Both {#id ok}→## Both {#id}']);
});

test('migrate: heading attributes v2 keeps are not rewritten, and {agent} is written agent=true', () => {
  const p = checkCase(doc('## Kept {#id .c}\n\n## Skipped {agent=skip}\n\n## Flag {agent}\n\n## Both {agent ok}\n\n```\n## Code {}\n```'));
  // v1 reads a bare `agent` as agent=true (data-agent="true"); written out, spec v2 reads the list as attributes too.
  assert.deepEqual(edits(p, 'heading-braces'), ['9:## Flag {agent}→## Flag {agent=true}', '11:## Both {agent ok}→## Both {agent=true ok}', '11:## Both {agent=true ok}→## Both {agent=true}']);
  assert.deepEqual(notes(p, 'heading-braces'), []);
});

// ---------------------------------------------------------------------------
// 6. Unknown directives (proposal 7b)
// ---------------------------------------------------------------------------

test('migrate: a literal :name[ outside the vocabulary is escaped', () => {
  const p = checkCase(doc('See :abbr[HTML], (:x[1]) and :Badge[wrong case].'));
  assert.deepEqual(edits(p, 'unknown-directive'), ['5:See :abbr[HTML], (:x[1]) and :Badge[wrong case].→See \\:abbr[HTML], (\\:x[1]) and \\:Badge[wrong case].']);
  assert.equal(changes(p, 'unknown-directive')[0].keeps, 'v2');
  assert.equal(changes(p, 'unknown-directive')[0].proposal, '7b');
});

test('migrate: known directives, code, math, HTML, links, attributes and other colons are left alone', () => {
  const body = [
    ':badge[ok]{color=green} :kbd[K] `:code[x]` $:m[x]$ \\:done[x] a:b[c] :open[ without a close',
    '',
    '[link](https://x.test/:p[1]) <span title=":t[1]">s</span> [s]{title=":v[1]"}',
    '',
    '```',
    ':y[1]',
    '```',
    '',
    '<div>',
    ':z[1]',
    '</div>',
    '',
    '$$',
    ':w[1]',
    '$$',
  ].join('\n');
  assert.deepEqual(changes(checkCase(doc(body)), 'unknown-directive'), []);
});

// ---------------------------------------------------------------------------
// 7. Include sections (proposal 9)
// ---------------------------------------------------------------------------

const files: Record<string, string> = { 'terms.smd': '---\nsmd: 1\n---\n\n## Refunds\n\nWithin 30 days.\n\n## Pricing\n\nMonthly.\n' };
const readFile = (p: string) => files[p];

test('migrate: an include section found by a part of its heading becomes the heading\'s id', () => {
  const text = doc(':::include{file="terms.smd" section="refund"}\nSee the terms.\n:::');
  const p = checkCase(text, { readFile });
  assert.deepEqual(edits(p, 'include-section'), ['5::::include{file="terms.smd" section="refund"}→:::include{file="terms.smd" section="refunds"}']);
  assert.match(v1(p.result, { readFile }), /Within 30 days/);
  // Spec v2 matches only the id or the whole text: the migrated document includes under v2 what the original did under v1.
  assert.equal(asIs(p.result, { readFile }), v1(text, { readFile }));
  assert.doesNotMatch(asIs(text.replace('smd: 1', 'smd: 2'), { readFile }), /Within 30 days/, 'unmigrated, v2 finds no section');
  assert.deepEqual(changes(plan(text), 'include-section'), [], 'without a reader, includes are left alone');
});

test('migrate: an include section that matches exactly is left alone', () => {
  for (const section of ['refunds', 'Refunds', 'pricing']) {
    const text = doc(`:::include{file="terms.smd" section="${section}"}\nSee the terms.\n:::`);
    assert.deepEqual(changes(checkCase(text, { readFile }), 'include-section'), [], section);
  }
});

// ---------------------------------------------------------------------------
// 8. Enumerated values (proposal 11)
// ---------------------------------------------------------------------------

test('migrate: enumerated values are written in the vocabulary\'s case', () => {
  const text = doc(':::decision{status=Accepted} T\nx\n:::\n\n:::api{method=get path="/v1"}\nx\n:::\n\nRate :metric[3%]{label="Rate" trend=Up good=DOWN}.', 'smd: 1\nstatus: Draft\naudience: Both\ntheme: Dark');
  const p = checkCase(text, {}, false);
  // v1 reads them in any case already; only the audience label, which v1 translates in lower case only, changes.
  assert.equal(v1(p.result), v1(text).replace('For Both', 'For both'));
  assert.deepEqual(edits(p, 'value-case'), [
    '3:status: Draft→status: draft', '4:audience: Both→audience: both', '5:theme: Dark→theme: dark',
    '8::::decision{status=Accepted} T→:::decision{status=accepted} T',
    '12::::api{method=get path="/v1"}→:::api{method=GET path="/v1"}',
    '16:Rate :metric[3%]{label="Rate" trend=Up good=DOWN}.→Rate :metric[3%]{label="Rate" trend=up good=down}.',
  ]);
  assert.equal(changes(p, 'value-case')[0].keeps, 'v2');
});

test('migrate: values in their case, values outside the vocabulary and code are left alone', () => {
  const text = doc(':::decision{status=accepted} T\nx\n:::\n\n:::decision{status=Weird} T\nx\n:::\n\n`:metric[1]{label=x trend=Up}`\n\n```\n:::api{method=get path="/"}\n```', 'smd: 1\nstatus: draft');
  assert.deepEqual(changes(checkCase(text), 'value-case'), []);
});

// ---------------------------------------------------------------------------
// 9. Typography (proposal 8)
// ---------------------------------------------------------------------------

test('migrate: what the typographer changes is a note, or with keepTypography, typography: true', () => {
  const text = doc('"Quotes" -- dash... (c)\n\n`"code"` and $x--y$ stay.', 'smd: 1\ntitle: "It\'s here"');
  // Without the key, spec v2 shows the text as written; tools before 2.0 still curl it.
  const counted = checkCase(text, {}, false);
  assert.match(asIs(counted.result), /<h1 class="smd-doc-title">It's here<\/h1>[^]*<p>&quot;Quotes&quot; -- dash\.\.\. \(c\)<\/p>/);
  assert.equal(v1(counted.result), v1(text));
  assert.deepEqual(changes(counted, 'typography'), []);
  const [n] = notes(counted, 'typography');
  assert.match(n.reason, /changes 6 places today \(3 quotes, 1 dash, 1 ellipsis, 1 symbol\), on line\(s\) 3, 6\. Run with --keep-typography/);
  // With it, spec v2 shows the document as v1 does.
  const kept = checkCase(text, { keepTypography: true });
  assert.equal(asIs(kept.result), v1(text));
  assert.notEqual(asIs(counted.result), v1(text));
  assert.deepEqual(edits(kept, 'typography'), ['4:→typography: true']);
  assert.equal(changes(kept, 'typography')[0].keeps, 'v2');
  assert.match(kept.result, /^---\nsmd: 2\ntitle: "It's here"\ntypography: true\n---\n/);
  assert.match(asIs(kept.result), /<h1 class="smd-doc-title">It’s here<\/h1>[^]*<p>“Quotes” – dash… ©<\/p>/);
});

test('migrate: no typography step without typographic text, or when the key is set', () => {
  assert.deepEqual(plan(doc('Plain text, `"code"`.'), { keepTypography: true }).steps.filter((s) => s.kind === 'typography'), []);
  assert.deepEqual(plan(doc('"Quotes"', 'smd: 1\ntypography: false'), { keepTypography: true }).steps.filter((s) => s.kind === 'typography'), []);
});

test('migrate: keepTypography adds front matter to a document without it', () => {
  const p = checkCase('"Quotes" here.\n', { keepTypography: true }, false);
  assert.equal(p.result, '---\nsmd: 2\ntypography: true\n---\n\n"Quotes" here.\n');
  assert.equal(formatSmd(p.result), p.result);
});

// ---------------------------------------------------------------------------
// 10. Fuzzy links (proposal 8)
// ---------------------------------------------------------------------------

test('migrate: a bare domain linked today is a note, or with linkDomains, a Markdown link to the same address', () => {
  const text = doc('Docs at example.com and docs.example.org/guide, not https://x.test, www.example.org, a@b.test or `c.test`.');
  // Without the rewrite, spec v2 shows the bare domains as text; tools before 2.0 still link them.
  const noted = checkCase(text, {}, false);
  assert.match(asIs(noted.result), /Docs at example\.com and docs\.example\.org\/guide, not <a href="https:\/\/x\.test">/);
  assert.equal(v1(noted.result), v1(text));
  assert.deepEqual(notes(noted, 'fuzzy-link').map((s) => s.line + 1), [5]);
  assert.match(notes(noted, 'fuzzy-link')[0].reason, /"example\.com", "docs\.example\.org\/guide" are linked today\. Run with --link-domains to write them as Markdown links/);
  // With it, both versions show the same links.
  const linked = checkCase(text, { linkDomains: true });
  assert.equal(asIs(linked.result), v1(text));
  assert.deepEqual(edits(linked, 'fuzzy-link').map((e) => e.split('→')[1]), [
    'Docs at [example.com](http://example.com) and [docs.example.org/guide](http://docs.example.org/guide), not https://x.test, www.example.org, a@b.test or `c.test`.',
  ]);
  assert.equal(changes(linked, 'fuzzy-link')[0].keeps, 'v1');
  assert.equal(v1(linked.result), v1(text));
});

test('migrate: links spec v2 doesn\'t make are rewritten too (//host, WWW. in capitals); their text keeps --, ... and (c)', () => {
  const text = doc('See //cdn.example.com, WWW.EXAMPLE.COM, my--site.com/a...b and example.com/(c)/x.');
  const p = checkCase(text, { linkDomains: true, keepTypography: true });
  assert.deepEqual(edits(p, 'fuzzy-link').map((e) => e.split('→')[1]), [
    'See [//cdn.example.com](//cdn.example.com), [WWW.EXAMPLE.COM](http://WWW.EXAMPLE.COM), [my-\\-site.com/a.\\.\\.b](http://my--site.com/a...b) and [example.com/\\(c)/x](http://example.com/(c)/x).',
  ]);
  assert.match(asIs(p.result), /<a href="http:\/\/my--site\.com\/a\.\.\.b">my--site\.com\/a\.\.\.b<\/a>/);
  assert.equal(asIs(p.result), v1(text));
});

test('migrate: www. text v1 doesn\'t link (an unknown top-level domain) is a note: spec v2 links it', () => {
  const p = checkCase(doc('Staging is www.shop.test, not <a href="x">www.shop.test</a> or [www.shop.test](y).'), { linkDomains: true }, false);
  assert.deepEqual(changes(p, 'fuzzy-link'), []);
  const [n, ...more] = notes(p, 'fuzzy-link');
  assert.deepEqual(more, []);
  assert.match(n.reason, /"www\.shop\.test" is text today, and spec v2 links it \(a GFM autolink literal\); escape its first dot/);
  assert.match(asIs(p.result), /Staging is <a href="http:\/\/www\.shop\.test">www\.shop\.test<\/a>, not <a href="x">www\.shop\.test<\/a>/);
  assert.match(asIs(doc('Staging is www\\.shop.test.', 'smd: 2')), /Staging is www\.shop\.test\./, 'the escape the note suggests keeps it text');
});

test('migrate: a bare domain in the title or summary is a note: the header links it today', () => {
  const p = checkCase(doc('Body.', 'smd: 1\nsummary: See example.com first.'), { linkDomains: true }, false);
  assert.deepEqual(changes(p, 'fuzzy-link'), []);
  const [n] = notes(p, 'fuzzy-link');
  assert.equal(n.line + 1, 3);
  assert.match(n.reason, /"example\.com" in "summary" is linked in the header today/);
});

// ---------------------------------------------------------------------------
// 11. Variables (proposal 10)
// ---------------------------------------------------------------------------

test('migrate: a shown value YAML reads differently is a note, or with quoteVariables, quoted', () => {
  // `estimate` is in no `{{…}}`, but the agent view's header lists it; `toc` is a key the headers leave out.
  const text = doc('Release {{release}}, flag {{flag}}.', 'smd: 1\nversion: 2.10\nrelease: 1.0 # the first\nflag: True\nestimate: 3.0\nsame: 2\ntitled: "2.10"\ntoc: True');
  const noted = checkCase(text);
  assert.deepEqual(notes(noted, 'variable-spelling').map((s) => s.line + 1), [3, 4, 5, 6]);
  assert.match(notes(noted, 'variable-spelling')[0].reason, /"version: 2\.10" is shown as "2\.1" today and as "2\.10" in spec v2/);
  const quoted = checkCase(text, { quoteVariables: true }, false);
  assert.deepEqual(edits(quoted, 'variable-spelling'), [
    '3:version: 2.10→version: "2.10"', '4:release: 1.0 # the first→release: "1.0" # the first', '5:flag: True→flag: "True"', '6:estimate: 3.0→estimate: "3.0"',
  ]);
  assert.match(v1(quoted.result), /Release 1\.0, flag True\./);
  // The step keeps the v2 meaning: unquoted, the migrated document shows under v2 what quoted shows everywhere.
  assert.match(asIs(noted.result), /Release 1\.0, flag True\./);
  assert.equal(asIs(quoted.result), v1(quoted.result));
});

test('migrate: a value in a list or a nested key that shows differently is a note to quote by hand', () => {
  const text = doc('Number {{release.number}}.', 'smd: 1\ntags: [docs, 1.10]\nrelease:\n  number: 4.0\n  name: x\nother:\n  deep: 1.0');
  const p = checkCase(text, { quoteVariables: true }, false);
  assert.deepEqual(changes(p, 'variable-spelling'), []);
  // tags (the header shows them), release (used), and other (the agent view's header lists it as JSON).
  assert.deepEqual(notes(p, 'variable-spelling').map((s) => s.line + 1), [3, 4, 7]);
  assert.match(notes(p, 'variable-spelling')[0].reason, /"tags" .*quote it by hand/);
});

// ---------------------------------------------------------------------------
// 12. The smd key (versioning rules)
// ---------------------------------------------------------------------------

test('migrate: smd: 1, a missing key, an invalid value or no front matter become smd: 2', () => {
  assert.deepEqual(edits(checkCase(doc('x')), 'version'), ['2:smd: 1→smd: 2']);
  assert.deepEqual(edits(checkCase(doc('x', 'title: T')), 'version'), ['2:→smd: 2']);
  assert.equal(checkCase(doc('x', 'title: T')).result, doc('x', 'smd: 2\ntitle: T'));
  for (const value of ['true', '"1"', '1.0', '[1] # list']) {
    const p = checkCase(doc('x', `smd: ${value}`));
    assert.equal(p.result, doc('x', value.includes('#') ? 'smd: 2 # list' : 'smd: 2'), value);
    assert.equal(p.from, 1);
  }
  const bare = checkCase('# Title\n\nText.\n');
  assert.equal(bare.result, '---\nsmd: 2\n---\n\n# Title\n\nText.\n');
  assert.equal(formatSmd(bare.result), bare.result);
  assert.equal(plan('').result, '---\nsmd: 2\n---\n');
});

test('migrate: smd: 2 needs nothing, a newer version and broken front matter are notes', () => {
  const v2 = plan(doc('## Returns {ok}', 'smd: 2'));
  assert.deepEqual(v2, { from: 2, steps: [], result: doc('## Returns {ok}', 'smd: 2') }, 'a v2 document already reads {ok} as text');
  const v3 = plan(doc('x', 'smd: 3'));
  assert.equal(v3.from, 3);
  assert.deepEqual(v3.steps.map((s) => [s.kind, s.note]), [['version', true]]);
  const broken = plan('---\nsmd: [1\n---\n\nx\n');
  assert.deepEqual(changes(broken, 'version'), []);
  assert.match(notes(broken, 'version')[0].reason, /front matter does not parse/);
  // YAML reads an indented line after it as part of the value ("1 more"): rewriting the `1` would not make it 2.
  const continued = plan(doc('x', 'smd: 1\n  more'));
  assert.deepEqual(changes(continued, 'version'), []);
  assert.match(notes(continued, 'version')[0].reason, /not written as a value on its own line/);
});

// ---------------------------------------------------------------------------
// The plan as a whole
// ---------------------------------------------------------------------------

const corpusDir = path.join(__dirname, 'compat', 'corpus');
const corpusRead = (rel: string) => {
  try { return fs.readFileSync(path.join(corpusDir, rel), 'utf8'); } catch { return undefined; }
};

test('migrate: corpus/migrate.smd has a case for every step', () => {
  const text = fs.readFileSync(path.join(corpusDir, 'migrate.smd'), 'utf8');
  assert.equal(formatSmd(text), text, 'fmt-clean');
  assert.deepEqual(validateSmd(text, { readFile: corpusRead, today: TODAY }).filter((d) => d.severity === 'error' || d.severity === 'warning'), []);
  const p = plan(text, { readFile: corpusRead });
  assert.deepEqual(p.steps.map((s) => `${s.kind}:${s.line + 1}${s.note ? ' note' : ''}`), [
    'closer:15', 'closer:19', 'duplicate-attrs:26', 'title-text:31', 'agent-priority:38', 'math-delimiters:44', 'heading-braces:47', 'attr-escapes:78', 'unknown-directive:51', 'unknown-directive:79',
    'include-section:60', 'value-case:5', 'value-case:66', 'value-case:70', 'typography:74 note', 'fuzzy-link:74 note', 'variable-spelling:6 note', 'version:2',
  ]);
  assert.deepEqual(new Set(p.steps.map((s) => s.kind)), new Set(KIND_ORDER), 'every kind of step');
  // Only the steps that keep the v2 meaning change the v1 rendering, and of these only the backslash step shows: v1 reads
  // the `\\\\` it writes as two backslashes (the title's inline Markdown shows one of each pair), v2 as one.
  const unc = String.raw`<span class="smd-sr-only">Note: </span>\server\share`;
  const v1Unc = String.raw`<span class="smd-sr-only">Note: </span>\\server\share`;
  assert.equal(v1(p.result, { readFile: corpusRead }).replace(v1Unc, unc), v1(text, { readFile: corpusRead }));
  assert.ok(asIs(p.result, { readFile: corpusRead }).includes(unc), 'v2 shows the title as v1 did');
  // Spec v2 shows the typography and the bare domain differently until --keep-typography and --link-domains keep them.
  assert.notEqual(asIs(p.result, { readFile: corpusRead }), v1(text, { readFile: corpusRead }));
  const kept = plan(text, { readFile: corpusRead, keepTypography: true, linkDomains: true });
  // Typography and links as v1 shows them; only `version: 2.10` shows as written (proposal 10, --quote-variables).
  assert.equal(asIs(kept.result, { readFile: corpusRead }).replaceAll('2.10', '2.1'), v1(text, { readFile: corpusRead }));
  const all = plan(text, { readFile: corpusRead, keepTypography: true, linkDomains: true, quoteVariables: true });
  assert.deepEqual(all.steps.filter((s) => s.note), []);
  assert.match(all.result, /^---\nsmd: 2\n[^]*version: "2\.10"\n[^]*typography: true\n---\n/);
  assert.match(all.result, /Docs live at \[example\.com\]\(http:\/\/example\.com\) and www\.example\.org\./);
  assert.deepEqual(changes(plan(all.result, { readFile: corpusRead, force: true })), []);
});

/** Every tracked .smd file of the repository (and the untracked ones beside them), found without Git. */
function repositoryDocuments(): string[] {
  const root = path.join(__dirname, '..', '..');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'out', 'site'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.smd')) out.push(full);
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Rendered HTML as `v1` compares it, without the task boxes' source lines either. */
const shownV2 = (text: string, readFile?: MigrationOptions['readFile']) => asIs(text, { readFile }).replaceAll(/ data-task-line="\d+"/g, '');

test('migrate: every .smd file in the repository gets a plan that settles and keeps its v1 rendering', () => {
  const documents = repositoryDocuments();
  assert.ok(documents.length > 30, `found ${documents.length} documents`);
  let comparedV2 = 0;
  for (const file of documents) {
    const text = fs.readFileSync(file, 'utf8');
    const reader = (rel: string) => {
      try { return fs.readFileSync(path.resolve(path.dirname(file), rel), 'utf8'); } catch { return undefined; }
    };
    const p = plan(text, { readFile: reader });
    const again = changes(plan(p.result, { readFile: reader, force: true }));
    // corpus/v2-validation.smd says smd: 2 and pins, silenced, the errors of every document that the plan removes;
    // corpus/v2-fences.smd says smd: 2 and pins a closing fence that matches no container, which the plan fixes.
    if (path.basename(file) === 'v2-validation.smd') assert.deepEqual(again.map((s) => s.kind), ['duplicate-attrs', 'title-text', 'agent-priority'], file);
    else if (path.basename(file) === 'v2-fences.smd') assert.deepEqual(again.map((s) => s.kind), ['closer'], file);
    else assert.deepEqual(again, [], file);
    if (p.from < 2 && !changes(p).some((s) => s.keeps === 'v2')) assert.equal(v1(p.result, { readFile: reader }), v1(text, { readFile: reader }), file);
    // Spec v2 shows it as v1 shows the original once --keep-typography and --link-domains keep its typography and links
    // (task boxes' source lines move with the added front matter line).
    const kept = plan(text, { readFile: reader, keepTypography: true, linkDomains: true });
    // Proposal 10 (values shown as written) is not this comparison's.
    if (p.from < 2 && !kept.steps.some((s) => (s.keeps === 'v2' && s.kind !== 'typography' && !s.note) || s.kind === 'variable-spelling')) {
      assert.equal(shownV2(kept.result, reader), shownV2(text, reader), `${file} under spec v2`);
      comparedV2++;
    }
  }
  assert.ok(comparedV2 >= 20, `${comparedV2} documents compared under spec v2`);
});

/** Rendered HTML as `v1` compares it, without the task boxes' source lines either (the version step may add a line). */
const shown = (text: string, options: MigrationOptions = {}) => v1(text, options).replaceAll(/ data-task-line="\d+"/g, '');

test('migrate: a migrated document renders under spec v2 as the original renders under v1 (corpus and examples)', () => {
  const corpusDir = path.join(__dirname, 'compat', 'corpus');
  const dirs = [corpusDir, path.join(__dirname, '..', '..', 'examples')];
  const files = dirs.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).map((f) => path.join(dir, f)));
  // The spec v2 corpus documents, read as v1 documents: their twins, which v1 reads differently, migrate too.
  const twins = ['v2-math.smd', 'v2-fences.smd'].map((f) => ({ file: `${f} (smd: 1)`, text: fs.readFileSync(path.join(corpusDir, f), 'utf8').replace('\nsmd: 2\n', '\nsmd: 1\n') }));
  const documents = [...files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })), ...twins];
  const migrated: string[] = [];
  for (const { file, text } of documents) {
    const reader = (rel: string) => {
      try { return fs.readFileSync(path.resolve(path.dirname(file), rel), 'utf8'); } catch { return undefined; }
    };
    const options = { readFile: reader };
    // Typography, links and values shown as written kept by the options (proposals 8 and 10).
    const p = plan(text, { ...options, keepTypography: true, linkDomains: true, quoteVariables: true });
    if (p.from >= 2) continue;
    assert.match(p.result, /\nsmd: 2\n/, file);
    if (changes(p).some((s) => s.kind === 'closer' || s.kind === 'math-delimiters')) migrated.push(path.basename(file));
    // A value the backslash step (proposal 6) wrote with `\\` reads as two backslashes with the v1 rules, as one with v2.
    const escaped = changes(p, 'attr-escapes').length > 0;
    // `shown` reads with the v1 rules, `shownV2` with the migrated document's own, v2: they agree.
    if (!escaped) assert.equal(shownV2(p.result, reader), shown(p.result, options), `${file}: the migrated document, spec v2 and v1`);
    // Steps that keep the v2 meaning may change the v1 rendering (corpus/vocabulary-case.smd: proposal 11; quoted
    // values: proposal 10); their v2 rules are not this comparison's. The backslash step is meant to: v2 reads as v1 did
    // (corpus/attribute-escapes.smd; corpus/migrate.smd quotes a value too, and v2InlineRules.test.ts compares it).
    const quoted = changes(p, 'variable-spelling').length > 0;
    if ((!escaped || quoted) && shown(p.result, options) !== shown(text, options)) continue;
    assert.equal(shownV2(p.result, reader), shown(text, options), `${file}: the migrated document under spec v2`);
  }
  // The documents whose closing fences or `$$` delimiters spec v2 reads differently until they are migrated.
  assert.deepEqual(migrated.sort((a, b) => a.localeCompare(b)), ['migrate.smd', 'v2-fences.smd (smd: 1)', 'v2-hints.smd', 'v2-math.smd (smd: 1)']);
});

test('migrate: the report groups steps by kind, with 1-based lines and short diffs', () => {
  const p = plan(doc('::::note\nx\n:::\n\nSee :abbr[x].'));
  const report = migrationReport('a.smd', p);
  assert.match(report, /^a\.smd: 3 changes and 0 notes to migrate from smd: 1 to spec v2\n/);
  assert.match(report, /\n {2}Closing fences \(proposal 3; v1 rendering kept\):\n {4}Spec v2 pairs[^\n]*\n {4}line 7\n {6}- :::\n {6}\+ ::::\n/);
  assert.match(report, /Unknown inline directives \(proposal 7b; v2 meaning kept\)/);
  assert.match(report, /Spec version \(RFC versioning rules; v1 rendering kept\)/);
  assert.equal(migrationReport('b.smd', plan(doc('x', 'smd: 2'))), 'b.smd: already spec v2 (smd: 2)\n');
  assert.match(migrationSummary([p, plan(doc('x', 'smd: 2'))]), /^\n2 files checked: 1 to migrate to spec v2 \(3 changes, 0 notes\)\.\nDry run: nothing was written\. Styled Markdown 2\.0 applies the migration\.\n$/);
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

const cli = path.join(__dirname, '..', 'dist', 'cli.js');

test('CLI: smd migrate --to 2 --dry-run, its options and exit codes', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-migrate-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.smd'), doc('"Quoted" text.\n\n::::note\nx\n:::'));
    fs.writeFileSync(path.join(dir, 'new.smd'), doc('Text.', 'smd: 2'));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'migrate', ...args], { cwd: dir, encoding: 'utf8' });

    const report = run('old.smd', '--to', '2', '--dry-run');
    assert.equal(report.status, 1, 'steps to migrate: exit 1');
    assert.match(report.stdout, /old\.smd: 2 changes and 1 note to migrate from smd: 1 to spec v2/);
    assert.match(report.stdout, /Dry run: nothing was written/);
    assert.equal(fs.readFileSync(path.join(dir, 'old.smd'), 'utf8'), doc('"Quoted" text.\n\n::::note\nx\n:::'), 'nothing is written');

    const clean = run('new.smd', '--to', '2', '--dry-run');
    assert.equal(clean.status, 0, 'nothing to migrate: exit 0');
    assert.match(clean.stdout, /new\.smd: already spec v2 \(smd: 2\)/);

    const json = run('.', '--to', '2', '--dry-run', '--json', '--keep-typography');
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout) as { files: Array<{ file: string; from: number; steps: Array<{ kind: string }>; result: string }>; changes: number; notes: number };
    assert.deepEqual(parsed.files.map((f) => [path.basename(f.file), f.from, f.steps.map((s) => s.kind)]), [
      ['new.smd', 2, []], ['old.smd', 1, ['closer', 'typography', 'version']],
    ]);
    assert.deepEqual([parsed.changes, parsed.notes], [3, 0]);
    assert.match(parsed.files[1].result, /typography: true/);

    const usage = (args: string[], message: RegExp) => {
      const r = run(...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, message);
    };
    usage(['old.smd', '--to', '2'], /^1\.10 can only report: run with --dry-run\. Styled Markdown 2\.0 applies the migration\.\n$/);
    usage(['old.smd', '--dry-run'], /migrate needs --to 2\./);
    usage(['old.smd', '--to', '3', '--dry-run'], /Cannot migrate to "3": the only target is spec v2/);
    usage(['old.smd', '--to', '2', '--dry-run', '--keep-typo'], /Unknown option "--keep-typo" for migrate/);
    usage(['missing.smd', '--to', '2', '--dry-run'], /No \.smd files found/);
    assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /smd migrate <files\|dirs\.\.\.> --to 2 --dry-run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spec version step: the version is read as every tool reads it, and the whole value is replaced', () => {
  // A byte order mark after the value (found by the fuzzer) is part of it for YAML, not white space.
  for (const line of ['smd: [2]', 'smd: true', `smd: 1${String.fromCodePoint(0xfeff)}`, 'smd: "2 "']) {
    const p = plan(`---\n${line}\n---\n\nText.\n`);
    assert.equal(p.from, 1, line);
    assert.equal(p.result, '---\nsmd: 2\n---\n\nText.\n', line);
    assert.deepEqual(plan(p.result).steps, [], `${line}: the migrated document needs nothing more`);
  }
  assert.deepEqual(plan('---\nsmd: 2.0\n---\n\nText.\n').steps, [], 'smd: 2.0 reads as 2');
});

test('migrate: backslashes are not rewritten when the plan cannot write smd: 2', () => {
  // The front matter is never closed (fuzz seed 99, case 2602): the document stays v1, so its values must read as v1 reads them.
  const text = '---\n:::api{method=POST path="/v1/x\\" auth=token} Endpoint';
  const p = plan(text);
  assert.deepEqual(changes(p, 'attr-escapes'), []);
  assert.deepEqual(changes(plan(p.result, { force: true })), []);
});
