import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import { agentView, buildSite, renderSmd, smdToMarkdown, SUPPORTED_LANGUAGES, validateSmd } from '../src/core';
import { renderPage } from '../src/core/assets';
import {
  completeMessages, documentLanguage, EN, format, languageTag, matchLanguage, messagesFor, term, type MessageKey,
} from '../src/core/i18n';
import { LOCALES } from '../src/core/locales';
import { lightTheme } from '../src/pdf';

const root = join(__dirname, '..', '..');
const corpus = join(root, 'extension', 'test', 'compat', 'corpus');
const localized = readFileSync(join(corpus, 'localized.smd'), 'utf8');
const TODAY = '2026-02-01';

/** Every example and corpus document, by path. */
const documents = (): Array<[string, string]> => [join(root, 'examples'), corpus]
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.smd')).map((f) => join(dir, f)))
  .map((file): [string, string] => [file, readFileSync(file, 'utf8')]);

/** The document with `key: value` as the first front matter line (it has front matter). */
const withKey = (text: string, line: string) => text.replace(/^---\r?\n/, `---\n${line}\n`);

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b));

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

test('every locale translates every label, keeps its placeholders, and nothing else', () => {
  const keys = Object.keys(EN).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(Object.keys(LOCALES).sort((a, b) => a.localeCompare(b)), ['de', 'es', 'fr', 'ja', 'pt', 'zh']);
  for (const [lang, messages] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(messages).sort((a, b) => a.localeCompare(b)), keys, lang);
    for (const key of keys) {
      const text = messages[key as MessageKey];
      assert.ok(text.trim(), `${lang} ${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(EN[key as MessageKey]), `${lang} ${key} placeholders`);
    }
  }
});

test('labels are plain text: no markup characters, so they are safe in text and escaped in attributes', () => {
  for (const messages of [EN, ...Object.values(LOCALES)]) {
    for (const [key, text] of Object.entries(messages)) assert.doesNotMatch(text, /[<>&]/, key);
  }
});

test('in English each word for a document value is the value itself, so English output never changes', () => {
  for (const [key, text] of Object.entries(EN)) {
    const [group, value] = key.split('.');
    if (['audience', 'docStatus', 'decisionStatus', 'impact', 'likelihood', 'riskStatus', 'priority', 'trend', 'tone', 'color'].includes(group)) {
      assert.equal(text, value, key);
    }
  }
  assert.equal(term(EN, 'priority', 'High'), 'High');
  assert.equal(term(EN, 'priority', 'HIGH'), 'HIGH');
  const de = messagesFor('de');
  assert.equal(term(de, 'priority', 'high'), 'hoch');
  assert.equal(term(de, 'priority', 'High'), 'Hoch');
  assert.equal(term(de, 'priority', 'HIGH'), 'HIGH', 'other spellings stay as written');
  assert.equal(term(de, 'priority', 'P1'), 'P1');
  assert.equal(term(de, 'color', '#ff0000'), '#ff0000');
});

test('language tags match by BCP 47 lookup, falling back to English', () => {
  assert.equal(matchLanguage('de'), 'de');
  assert.equal(matchLanguage('DE-at'), 'de');
  assert.equal(matchLanguage('pt-BR'), 'pt');
  assert.equal(matchLanguage('pt_BR'), 'pt');
  assert.equal(matchLanguage('zh-Hant-TW'), 'zh');
  assert.equal(matchLanguage('en-GB'), 'en');
  assert.equal(matchLanguage('ko'), undefined);
  assert.equal(languageTag(' pt_BR '), 'pt-BR');
  assert.equal(languageTag('not a tag'), undefined);
  assert.equal(languageTag(42), undefined);
  assert.equal(documentLanguage(undefined, 'fr'), 'fr');
  assert.equal(documentLanguage('de', 'fr'), 'de', 'the document wins over the fallback');
  assert.equal(documentLanguage('bad tag!', undefined), 'en');
  assert.deepEqual(SUPPORTED_LANGUAGES, ['en', 'de', 'es', 'fr', 'ja', 'pt', 'zh']);
  assert.equal(messagesFor('ko'), messagesFor(undefined));
  assert.equal(messagesFor('pt-BR')['callout.note'], 'Nota');
});

test('a label a locale lacks, or leaves empty, falls back to English', () => {
  const partial = completeMessages({ 'callout.note': 'Hinweis', 'callout.tip': '' });
  assert.equal(partial['callout.note'], 'Hinweis');
  assert.equal(partial['callout.tip'], 'Tip');
  assert.equal(partial['footnote.heading'], 'Footnotes');
  assert.equal(format('Figure {n} of {total}', { n: 2 }), 'Figure 2 of {total}');
  assert.equal(format('{a}', { a: '{b}', b: 'x' }), '{b}', 'filled-in values are not filled in again');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('without lang, or with an English lang, every example and corpus document renders as before', () => {
  for (const [file, text] of documents()) {
    if (/^lang:/m.test(text)) continue;
    const base = renderSmd(withKey(text, 'custom: en'), { today: TODAY }).html;
    assert.doesNotMatch(base, /<article class="smd-doc" lang=/, file);
    for (const lang of ['en', 'en-GB', 'EN']) assert.equal(renderSmd(withKey(text, `lang: ${lang}`), { today: TODAY }).html, base, `${file} ${lang}`);
    assert.equal(renderSmd(text, { today: TODAY, lang: 'en' }).html, renderSmd(text, { today: TODAY }).html, file);
  }
});

test('a German document gets German labels, its language on the article and the runtime labels', () => {
  const { html, lang } = renderSmd(localized, { today: TODAY });
  assert.equal(lang, 'de');
  assert.match(html, /^<article class="smd-doc" lang="de" data-smd-labels="\{&quot;copy&quot;:&quot;Kopieren&quot;/);
  for (const text of [
    'in Prüfung', 'Aktualisiert am 2026-10-01', 'Für Menschen und Agenten', '>Verantwortlich<', '>Schlagwörter<',
    'aria-label="Inhalt"', '<span>Hinweis</span>', '<span class="smd-sr-only">Warnung: </span>', '>Abbildung 1</a>',
    '>Tabelle 1:</span>', '>hoch</span>', 'title="Fällig am 2026-01-15 (überfällig)"', '> · überfällig</span>',
    'aria-label="grün"', 'aria-label="Fortschritt"', '(steigend, gut)', 'smd-decision-label">Entscheidung<', '>angenommen<',
    'Auswirkung <b>hoch</b>', 'Wahrscheinlichkeit <b>mittel</b>', '>offen<', 'Auswirkung ↓ · Wahrscheinlichkeit →',
    'title="Auswirkung hoch, Wahrscheinlichkeit mittel: 1 Risiko/Risiken"', 'data-title="Tab"', '<summary>Details</summary>',
    '<span>Für Agenten</span>', ':::include braucht eine Datei', '>Fußnoten</h2>', 'aria-label="Zurück zur Referenz 1"',
    '<figcaption class="smd-quote-caption">— <span class="smd-quote-author">Ada Lovelace</span>, <cite>Notizen</cite></figcaption>',
  ]) assert.ok(html.includes(text), text);
  const zh = renderSmd(localized.replace('lang: de', 'lang: zh'), { today: TODAY }).html;
  assert.ok(zh.includes('——<span class="smd-quote-author">Ada Lovelace</span>，<cite>Notizen</cite>'));
  for (const english of ['>Note<', 'Overdue', '>overdue', 'Figure 1', 'Footnotes', 'Back to reference', 'Likelihood']) {
    assert.ok(!html.includes(english), english);
  }
});

test('each locale renders the whole corpus document; regional tags use their language', () => {
  for (const lang of Object.keys(LOCALES)) {
    const { html } = renderSmd(localized.replace('lang: de', `lang: ${lang}`), { today: TODAY });
    assert.ok(html.includes(`<span>${LOCALES[lang]['callout.note']}</span>`), lang);
    assert.ok(html.includes(`>${format(LOCALES[lang]['figure.figure'], { n: 1 })}</a>`), lang);
  }
  const br = renderSmd(localized.replace('lang: de', 'lang: pt-BR'), { today: TODAY }).html;
  assert.match(br, /^<article class="smd-doc" lang="pt-BR" data-smd-labels=/);
  assert.ok(br.includes('<span>Nota</span>'));
});

test('a language without labels keeps English labels but still marks the language', () => {
  const html = renderSmd(localized.replace('lang: de', 'lang: ko'), { today: TODAY }).html;
  assert.match(html, /^<article class="smd-doc" lang="ko">/);
  assert.ok(html.includes('<span>Note</span>'));
  const bad = renderSmd(localized.replace('lang: de', 'lang: "x y"'), { today: TODAY });
  assert.match(bad.html, /^<article class="smd-doc">/);
  assert.equal(bad.lang, 'en');
});

test('the lang option is a fallback: the front matter wins', () => {
  const plain = ':::tip\nText\n:::\n';
  assert.ok(renderSmd(plain, { lang: 'fr' }).html.includes('<span>Astuce</span>'));
  assert.ok(renderSmd(`---\nlang: es\n---\n${plain}`, { lang: 'fr' }).html.includes('<span>Consejo</span>'));
  const page = renderPage(localized, { today: TODAY });
  assert.match(page, /<html lang="de" data-smd-theme-pref="auto">/);
  assert.match(renderPage('# Plain\n'), /<html lang="en" data-smd-theme-pref="auto">/);
  assert.equal(lightTheme('<html lang="pt-BR" data-smd-theme-pref="dark">'), '<html lang="pt-BR" data-smd-theme-pref="light">');
});

test('markdown-it plugin: the lang option, env.lang, then the front matter', () => {
  const src = ':::note\nText[^1]\n:::\n\n[^1]: A note.\n';
  const english = new MarkdownIt().use(smd).render(src);
  assert.ok(english.includes('<span>Note</span>') && english.includes('>Footnotes</h2>'));
  const fr = new MarkdownIt().use(smd, { lang: 'fr' });
  assert.ok(fr.render(src).includes('<span>Remarque</span>'));
  assert.ok(fr.render(src).includes('>Notes de bas de page</h2>'));
  assert.ok(fr.render(src, { lang: 'ja' }).includes('<span>メモ</span>'), 'env.lang overrides the option');
  const withFm = new MarkdownIt().use(smd, { frontMatter: true, lang: 'fr' });
  const page = withFm.render(`---\ntitle: T\nstatus: draft\nlang: de\n---\n${src}`, { lang: 'ja' });
  assert.ok(page.includes('<span>Hinweis</span>') && page.includes('>Entwurf</span>'), 'the front matter wins');
  assert.equal(new MarkdownIt().use(smd, { lang: 'en' }).render(src), english);
});

// ---------------------------------------------------------------------------
// What stays English
// ---------------------------------------------------------------------------

test('agent views and to-md stay English and unchanged by lang', () => {
  const asCustom = localized.replace('lang: de', 'custom: de');
  const agent = agentView(localized, { today: TODAY }).text;
  assert.equal(agent.replace('lang: de', 'custom: de'), agentView(asCustom, { today: TODAY }).text);
  assert.ok(agent.includes('Figure 1') && !agent.includes('Abbildung'));
  const md = smdToMarkdown(localized);
  assert.equal(md.replace('lang: de', 'custom: de'), smdToMarkdown(asCustom));
  assert.ok(md.includes('Figure 1') && !md.includes('Abbildung'));
});

test('validation: lang is checked, at most as information', () => {
  const codes = (lang: string) => validateSmd(`---\nsmd: 1\nlang: ${lang}\n---\n\nBody\n`)
    .filter((d) => d.code.startsWith('frontmatter/'))
    .map((d) => `${d.line}:${d.code}:${d.severity}`);
  for (const ok of ['de', 'pt-BR', 'en-GB', 'zh-Hant', 'ja']) assert.deepEqual(codes(ok), [], ok);
  for (const unknown of ['ko', 'not a tag', '42', '[de]', '{a: 1}']) assert.deepEqual(codes(unknown), ['2:frontmatter/lang:info'], unknown);
  const [d] = validateSmd('---\nsmd: 1\nlang: ko\n---\n').filter((x) => x.code === 'frontmatter/lang');
  assert.match(d.message, /render in English\. Supported: en, de, es, fr, ja, pt, zh\./);
});

// ---------------------------------------------------------------------------
// Static site and page runtime
// ---------------------------------------------------------------------------

test('smd build: the site language comes from --lang, else the home document', () => {
  const sources = [
    { path: 'index.smd', text: '---\ntitle: Start\nlang: de\n---\n\nSee [the plan](plan.smd).\n' },
    { path: 'plan.smd', text: '---\ntitle: Plan\nstatus: draft\n---\n\n- [ ] Ship :due[2026-01-01]\n' },
    { path: 'ja.smd', text: '---\ntitle: JA\nlang: ja\n---\n\n:::tip\nText\n:::\n' },
  ];
  const site = buildSite(sources, { today: TODAY });
  const page = (path: string) => site.files.find((f) => f.path === path)?.content ?? '';
  assert.match(page('plan.html'), /<html lang="de"/);
  assert.match(page('plan.html'), /<body class="smd-body smd-site" data-smd-root="" data-smd-labels="\{&quot;searchLabel&quot;/);
  for (const text of ['Zum Inhalt springen', 'placeholder="Suchen"', '>Übersicht</a>', 'aria-label="Brotkrümelnavigation"', 'Verlinkt von']) {
    assert.ok(page('plan.html').includes(text), text);
  }
  assert.match(page('ja.html'), /<html lang="ja"/);
  assert.ok(page('ja.html').includes('<span>ヒント</span>') && page('ja.html').includes('Zum Inhalt springen'));
  assert.ok(page('dashboard.html').includes('<h1 id="dashboard">Übersicht</h1>'));
  assert.ok(page('dashboard.html').includes('<th scope="col">Fällig</th>'));
  assert.ok(page('dashboard.html').includes('> · überfällig</span>'));
  const fr = buildSite(sources, { today: TODAY, lang: 'fr' });
  assert.ok((fr.files.find((f) => f.path === 'plan.html')?.content ?? '').includes('Aller au contenu'));
  const english = buildSite(sources.slice(1), { today: TODAY });
  assert.ok(!(english.files.find((f) => f.path === 'plan.html')?.content ?? '').includes('data-smd-labels'));
});

test('page runtime and site script read their labels from data-smd-labels, else English', () => {
  const { uiLabel } = createRequire(__filename)(join(__dirname, '..', 'media', 'runtime.js'));
  const host = { getAttribute: () => JSON.stringify({ copy: 'Kopieren', copied: '' }) };
  const el = { closest: () => host };
  assert.equal(uiLabel(el, 'copy', 'Copy'), 'Kopieren');
  assert.equal(uiLabel(el, 'copied', 'Copied'), 'Copied');
  assert.equal(uiLabel({ closest: () => null }, 'copy', 'Copy'), 'Copy');
  assert.equal(uiLabel({ closest: () => ({ getAttribute: () => '{bad' }) }, 'copy', 'Copy'), 'Copy');
  const siteJs = readFileSync(join(__dirname, '..', 'media', 'site.js'), 'utf8');
  for (const key of ['searchNoIndex', 'searchNone', 'searchCount', 'searchUnavailable']) assert.ok(siteJs.includes(`say('${key}'`), key);
});
