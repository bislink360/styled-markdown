// The JetBrains plugin in integrations/jetbrains: its TextMate bundle declares the extension's language, its grammar
// is the extension's made into one file (and up to date), every file the build copies exists, and its plugin.xml
// registers the classes it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(__dirname, '..', '..');
const pluginDir = join(root, 'integrations', 'jetbrains');
const UTF8 = 'utf8';

interface Contributes {
  languages: { id: string; aliases?: string[]; extensions?: string[]; configuration?: string }[];
  grammars: { language?: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string>; injectTo?: string[] }[];
}

const extension = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), UTF8)).contributes as Contributes;
const bundle = JSON.parse(readFileSync(join(pluginDir, 'bundle', 'package.json'), UTF8)).contributes as Contributes;

const MARKDOWN_SCOPE = 'text.html.markdown.smd';
const syntaxes = join(pluginDir, 'bundle', 'syntaxes');
const readJson = (file: string) => JSON.parse(readFileSync(file, UTF8));

test('jetbrains: the TextMate bundle declares the extension\'s .smd language and its own grammars', () => {
  const smd = extension.languages.find((l) => l.id === 'smd');
  assert.ok(smd, 'the extension declares the smd language');
  const { icon: _icon, ...withoutIcon } = smd as typeof smd & { icon?: unknown };
  assert.deepEqual(bundle.languages, [withoutIcon]);
  // The extension's main grammar as it is, without the injection grammar (JetBrains doesn't read `injectTo`; the
  // generated grammar has its rules), plus the plugin's copy of the Markdown grammar.
  const main = extension.grammars.find((g) => g.language === 'smd');
  assert.deepEqual(bundle.grammars, [main, { scopeName: MARKDOWN_SCOPE, path: './syntaxes/markdown.tmLanguage.json' }]);
  for (const grammar of bundle.grammars) {
    assert.ok(existsSync(join(pluginDir, 'bundle', grammar.path)), `bundle/${grammar.path} is missing`);
    assert.equal(readJson(join(pluginDir, 'bundle', grammar.path)).scopeName, grammar.scopeName, grammar.path);
  }
});

test('jetbrains: the bundle grammar is the extension\'s with its injection as its own, and up to date', async () => {
  const script = join(pluginDir, 'scripts', 'bundle-grammar.mjs');
  const { bundleGrammar } = (await import(pathToFileURL(script).href)) as { bundleGrammar: () => string };
  assert.equal(readFileSync(join(syntaxes, 'smd.tmLanguage.json'), UTF8), bundleGrammar(),
    'bundle/syntaxes/smd.tmLanguage.json is out of date: run node integrations/jetbrains/scripts/bundle-grammar.mjs');
  const grammar = readJson(join(syntaxes, 'smd.tmLanguage.json'));
  const injection = readJson(join(root, 'extension', 'syntaxes', 'smd-directives.injection.json'));
  assert.deepEqual(grammar.injections, { [injection.injectionSelector]: { patterns: injection.patterns } });
  // Every `#rule` it includes is its own, and the only grammars it includes are YAML and the plugin's Markdown.
  const includes = [...JSON.stringify(grammar).matchAll(/"include":"([^"]+)"/g)].map((m) => m[1]);
  for (const ref of includes.filter((i) => i.startsWith('#'))) assert.ok(ref.slice(1) in grammar.repository, `${ref} has no rule`);
  assert.deepEqual([...new Set(includes.filter((i) => !i.startsWith('#')))].sort(), ['source.yaml', MARKDOWN_SCOPE]);
});

test('jetbrains: the Markdown grammar copy uses its own scope throughout', () => {
  const text = readFileSync(join(syntaxes, 'markdown.tmLanguage.json'), UTF8);
  assert.equal(JSON.parse(text).scopeName, MARKDOWN_SCOPE);
  assert.doesNotMatch(text, /"text\.html\.markdown"/, 'it still names the IDE\'s Markdown grammar');
  assert.ok(existsSync(join(syntaxes, 'markdown.LICENSE.txt')), 'its MIT license notice ships with it');
});

test('jetbrains: every file the build copies into the plugin exists', () => {
  // build.gradle.kts copies these into the plugin's server/ and bundle/ folders, with bundle/ itself.
  for (const file of ['skills/styled-markdown-reader/scripts/smd.cjs', 'extension/language-configuration.json']) {
    assert.ok(existsSync(join(root, file)), `${file} is missing`);
  }
  const gradle = readFileSync(join(pluginDir, 'build.gradle.kts'), UTF8);
  for (const copied of ['skills/styled-markdown-reader/scripts/smd.cjs', 'dir("bundle")', 'extension/language-configuration.json', 'extension/package.json']) {
    assert.ok(gradle.includes(copied), `build.gradle.kts no longer reads ${copied}: update this test`);
  }
});

test('jetbrains: plugin.xml registers classes that exist', () => {
  const xml = readFileSync(join(pluginDir, 'src', 'main', 'resources', 'META-INF', 'plugin.xml'), UTF8);
  const sources = join(pluginDir, 'src', 'main', 'kotlin', 'com', 'bislink360', 'smd');
  const classes = new Set(readdirSync(sources).filter((f) => f.endsWith('.kt')).map((f) => `com.bislink360.smd.${f.slice(0, -3)}`));
  const registered = [...xml.matchAll(/(?:implementation|instance|class)="(com\.bislink360\.smd\.\w+)"/g)].map((m) => m[1]);
  assert.ok(registered.length >= 4, 'plugin.xml registers the provider, settings, bundle and action');
  for (const name of registered) assert.ok(classes.has(name), `plugin.xml names ${name}, which has no source file`);
  assert.match(xml, /<depends>com\.intellij\.modules\.lsp<\/depends>/);
  assert.match(xml, /<depends>org\.jetbrains\.plugins\.textmate<\/depends>/);
});
