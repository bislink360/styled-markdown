import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { agentView, extractTasks, formatSmd, renderSmd, smdToMarkdown, smdToPandocHtml, validateSmd } from '../src/core';
import { blocksHtml, renderBlocks, segmentSmd } from '../src/core/blocks';
import { smdToConfluence } from '../src/core/confluence';
import { markdownItSmd } from '../src/core/markdownIt';

/**
 * Front matter that fails to parse no longer hides content (spec v2 RFC, proposal 1, "all documents"): front matter
 * whose YAML is not a mapping, closed by a later `---` (a thematic break), renders its lines as written in a visible
 * error block, and the body after the closer renders as usual. Every reader agrees, whatever `smd` says.
 */

/** The RFC's example: the closing `---` was forgotten, so the thematic break closes the front matter. */
const forgotten = (smd: string) => `---\n${smd}\ntitle: F\n\n# Intro\n\nA paragraph with <b>tags</b> & \`code\`.\n\n- [ ] A task in the lost part\n\n---\n\n## After rule\n\n- [ ] A task after it\n`;
const DOCS: Array<[string, string]> = [['smd: 1', forgotten('smd: 1')], ['smd: 2', forgotten('smd: 2')], ['no smd key', forgotten('owner: x')]];
const ERROR_BLOCK = /<div class="smd-frontmatter-error" role="note" aria-label="Front matter could not be read" data-line="0"><div class="smd-frontmatter-error-title">Front matter could not be read<\/div><pre class="smd-frontmatter-error-yaml"><code>([^]*?)<\/code><\/pre><\/div>/;

test('render: the lines of front matter that does not parse show, escaped, in an error block; the body renders', () => {
  for (const [name, text] of DOCS) {
    const html = renderSmd(text).html;
    const m = ERROR_BLOCK.exec(html);
    assert.ok(m, name);
    assert.equal(m[1], `${text.split('\n')[1]}\ntitle: F\n\n# Intro\n\nA paragraph with &lt;b&gt;tags&lt;/b&gt; &amp; \`code\`.\n\n- [ ] A task in the lost part\n`, name);
    assert.ok(html.startsWith('<article class="smd-doc"><div class="smd-frontmatter-error"'), name);
    assert.match(html, /<h2 id="after-rule" data-line="12">After rule<\/h2>/, name);
    assert.doesNotMatch(html, /<h1/, 'the lost heading is text in the block, not a heading');
  }
});

test('render: YAML that is a list or a scalar is not a mapping either; good, empty and unclosed front matter are unchanged', () => {
  for (const yaml of ['- a\n- b', 'just text', ': [bad']) {
    const m = ERROR_BLOCK.exec(renderSmd(`---\n${yaml}\n---\nBody\n`).html);
    assert.equal(m?.[1], yaml.replace('<', '&lt;'), yaml);
  }
  for (const text of ['---\ntitle: Fine\n---\nBody\n', '---\n---\nBody\n', '---\ntitle: never closed\n\nBody\n', 'No front matter\n']) {
    assert.doesNotMatch(renderSmd(text).html, /smd-frontmatter-error/, text);
  }
  // `...` closes front matter too (YAML's document end marker).
  assert.match(renderSmd('---\ntitle: Dots\n...\nBody\n').html, /<h1 class="smd-doc-title">Dots<\/h1>/);
  assert.match(renderSmd('---\ntitle: [x\n...\nBody\n').html, /<code>title: \[x<\/code>/);
});

test('render: the block label follows the document language option, and the HTML a host gets has it too', () => {
  assert.match(renderSmd(forgotten('smd: 1'), { lang: 'de' }).html, /aria-label="Front Matter konnte nicht gelesen werden"/);
  const md = new MarkdownIt().use(markdownItSmd, { frontMatter: true });
  const html = md.render(forgotten('smd: 1'));
  assert.match(html, ERROR_BLOCK);
  assert.match(html, /<h2[^>]*>After rule<\/h2>/);
  // Without the frontMatter option the host renders the lines as Markdown, as before.
  assert.match(new MarkdownIt().use(markdownItSmd).render(forgotten('smd: 1')), /<h1[^>]*>Intro<\/h1>/);
});

test('agent view: a [front matter could not be read] line and the lines as written, then the body', () => {
  for (const [name, text] of DOCS) {
    const view = agentView(text).text;
    const lines = text.split('\n');
    assert.ok(view.startsWith(`[front matter could not be read]\n\`\`\`yaml\n${lines.slice(1, 10).join('\n')}\n\`\`\`\n\n## After rule  [L13]`), `${name}: ${view}`);
  }
  // A fence longer than any backtick run in the lines.
  assert.match(agentView('---\na: ```x```\n: [\n---\nBody\n').text, /^\[front matter could not be read\]\n````yaml\na: ```x```\n: \[\n````\n/);
  // An excerpt keeps it in its header.
  assert.match(agentView(forgotten('smd: 1'), { sections: ['After rule'] }).text, /^\(excerpt — sections: After rule\)\n\[front matter could not be read\]\n```yaml\n/);
  assert.doesNotMatch(agentView('---\ntitle: Fine\n---\nBody\n').text, /could not be read/);
});

test('to-md keeps the YAML block as written; fmt leaves it alone; tasks and the validator read the body', () => {
  for (const [name, text] of DOCS) {
    assert.ok(smdToMarkdown(text).startsWith(text.split('\n').slice(0, 12).join('\n')), name);
    assert.equal(formatSmd(text), text, name);
    assert.deepEqual(extractTasks(text).map((t) => t.text), ['A task after it'], name);
    const invalid = validateSmd(text).filter((d) => d.code === 'frontmatter/invalid');
    assert.deepEqual(invalid.map((d) => d.severity), ['error'], name);
  }
});

test('Block Editor: the front matter segment covers the lines, and the blocks put together are renderSmd\'s HTML', () => {
  for (const [name, text] of DOCS) {
    assert.deepEqual(segmentSmd(text).map((s) => [s.kind, s.start, s.end]), [['frontmatter', 0, 11], ['gap', 11, 12], ['block', 12, 13], ['gap', 13, 14], ['block', 14, 15], ['gap', 15, 16]], name);
    const blocks = renderBlocks(text);
    assert.match(blocks.header, ERROR_BLOCK, name);
    assert.equal(blocksHtml(blocks), renderSmd(text).html, name);
  }
});

test('exports show the lines too: Confluence as a danger callout with a code block, Pandoc from the rendered HTML', () => {
  const confluence = smdToConfluence(forgotten('smd: 1'));
  assert.match(confluence, /Front matter could not be read/);
  assert.match(confluence, /# Intro/);
  assert.match(smdToPandocHtml(forgotten('smd: 1')), /# Intro/);
});
