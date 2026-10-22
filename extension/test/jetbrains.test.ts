// The JetBrains plugin in integrations/jetbrains: its TextMate bundle declares the same language and grammars as
// the extension (the build copies the grammar files themselves from extension/), every file it copies exists, and
// its plugin.xml registers the classes it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const pluginDir = join(root, 'integrations', 'jetbrains');
const UTF8 = 'utf8';

interface Contributes {
  languages: { id: string; aliases?: string[]; extensions?: string[]; configuration?: string }[];
  grammars: { language?: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string>; injectTo?: string[] }[];
}

const extension = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), UTF8)).contributes as Contributes;
const bundle = JSON.parse(readFileSync(join(pluginDir, 'bundle', 'package.json'), UTF8)).contributes as Contributes;

test('jetbrains: the TextMate bundle declares the extension\'s .smd language and grammars', () => {
  const smd = extension.languages.find((l) => l.id === 'smd');
  assert.ok(smd, 'the extension declares the smd language');
  const { icon: _icon, ...withoutIcon } = smd as typeof smd & { icon?: unknown };
  assert.deepEqual(bundle.languages, [withoutIcon]);
  assert.deepEqual(bundle.grammars, extension.grammars);
});

test('jetbrains: every file the build copies into the plugin exists', () => {
  // build.gradle.kts copies these into the plugin's server/ and bundle/ folders.
  for (const file of ['skills/styled-markdown-reader/scripts/smd.cjs', 'extension/language-configuration.json']) {
    assert.ok(existsSync(join(root, file)), `${file} is missing`);
  }
  for (const grammar of bundle.grammars) {
    assert.ok(existsSync(join(root, 'extension', grammar.path)), `extension/${grammar.path} is missing`);
  }
  const gradle = readFileSync(join(pluginDir, 'build.gradle.kts'), UTF8);
  for (const copied of ['skills/styled-markdown-reader/scripts/smd.cjs', 'extension/syntaxes', 'extension/language-configuration.json', 'extension/package.json']) {
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
