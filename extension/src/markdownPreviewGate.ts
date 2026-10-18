import type MarkdownIt from 'markdown-it';
import { parseFrontMatter } from './core/frontmatter';
import { declaresSpec } from './core/specVersion';

/**
 * Which `.md` files get .smd syntax in VS Code's built-in Markdown preview (`smd.markdownPreview.enabled`), without
 * VS Code, so it can be tested on its own (see markdownPreview.ts).
 *
 * - `opt-in` (the default since 2.0): only files whose front matter has an `smd` key (`smd: 1` or `smd: 2`).
 * - `always`: every `.md` file, as in 1.x.
 * - `never`: none.
 */
export type PreviewMode = 'opt-in' | 'always' | 'never';

const MODES: readonly PreviewMode[] = ['opt-in', 'always', 'never'];

/** The setting's values by scope, as `WorkspaceConfiguration.inspect` gives them (the default left out on purpose). */
export interface PreviewSetting {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  globalLanguageValue?: unknown;
  workspaceLanguageValue?: unknown;
  workspaceFolderLanguageValue?: unknown;
}

/**
 * The mode the setting asks for. The most specific value a user set wins; 1.x's booleans still work: `true` (set
 * by the user, as 1.x's default no longer counts) is `always`, `false` is `never`. Nothing set, or a value that is
 * none of these, is the default, `opt-in`.
 */
export function previewMode(setting: PreviewSetting | undefined): PreviewMode {
  const value = [
    setting?.workspaceFolderLanguageValue, setting?.workspaceLanguageValue, setting?.globalLanguageValue,
    setting?.workspaceFolderValue, setting?.workspaceValue, setting?.globalValue,
  ].find((v) => v !== undefined);
  if (value === true) return 'always';
  if (value === false) return 'never';
  return MODES.find((mode) => mode === value) ?? 'opt-in';
}

/** Whether a `.md` file with this source gets .smd syntax in `mode`. */
export function previewApplies(mode: PreviewMode, source: string): boolean {
  if (mode !== 'opt-in') return mode === 'always';
  // Only a document that starts with front matter can opt in; most don't, so they skip the YAML parse.
  return source.startsWith('---') && declaresSpec(parseFrontMatter(source).data);
}

type Rule = (state: { env: unknown }, ...rest: never[]) => unknown;
/** A markdown-it rule chain (`md.core`, `md.block`, `md.inline`): its ruler, and the inline chain's second one. */
type Chain = { ruler: object; ruler2?: object };

/**
 * `md` for `apply`, which adds rules to it (applySmd), so that every rule it adds is skipped while a source
 * `applies` rejects is parsed, and every renderer rule it replaces renders that source's tokens as before. Other
 * sources are parsed and rendered with the rules. `md.parse` decides per source, so a host that parses once and
 * renders the tokens later (VS Code caches them) gets the same answer for both.
 */
export function applyWhen(md: MarkdownIt, applies: (source: string) => boolean, apply: (target: MarkdownIt) => void): void {
  // The envs of the parses without the rules, and the tokens they made.
  const plainEnvs = new WeakSet<object>();
  const plainTokens = new WeakSet<object>();
  const on = (state: { env: unknown }) => !(typeof state.env === 'object' && state.env !== null && plainEnvs.has(state.env));

  const rendererRules = { ...md.renderer.rules };
  apply(gatedInstance(md, on));
  for (const [type, previous] of Object.entries(rendererRules)) {
    const replaced = md.renderer.rules[type];
    if (!previous || !replaced || replaced === previous) continue;
    md.renderer.rules[type] = (tokens, idx, opts, env, self) =>
      (plainTokens.has(tokens) ? previous : replaced)(tokens, idx, opts, env, self);
  }

  const parse = md.parse;
  md.parse = function gatedParse(this: MarkdownIt, source: string, env: unknown) {
    // markdown-it needs an env object (md.render passes `{}`); one is made here, so it can be told apart.
    const e = typeof env === 'object' && env !== null ? env : {};
    const plain = !applies(source);
    if (plain) plainEnvs.add(e);
    else plainEnvs.delete(e);
    const tokens = parse.call(this, source, e);
    if (plain) plainTokens.add(tokens);
    return tokens;
  };
}

/** `md` with rulers that add every rule they are given behind `on`. Everything else is `md`'s own. */
function gatedInstance(md: MarkdownIt, on: (state: { env: unknown }) => boolean): MarkdownIt {
  const gate = (fn: Rule): Rule => (state, ...rest) => (on(state) ? fn(state, ...rest) : false);
  const gatedRuler = <R extends object>(ruler: R): R => {
    const r = ruler as unknown as Record<'push' | 'before' | 'after' | 'at', (...args: unknown[]) => unknown>;
    return Object.assign(Object.create(ruler) as R, {
      push: (name: string, fn: Rule, options?: unknown) => r.push.call(ruler, name, gate(fn), options),
      before: (before: string, name: string, fn: Rule, options?: unknown) => r.before.call(ruler, before, name, gate(fn), options),
      after: (after: string, name: string, fn: Rule, options?: unknown) => r.after.call(ruler, after, name, gate(fn), options),
      at: (name: string, fn: Rule, options?: unknown) => r.at.call(ruler, name, gate(fn), options),
    });
  };
  const gatedChain = <C extends Chain>(chain: C): C => {
    const gated: Partial<Chain> = { ruler: gatedRuler(chain.ruler) };
    if (chain.ruler2) gated.ruler2 = gatedRuler(chain.ruler2);
    return Object.assign(Object.create(chain) as C, gated);
  };
  return Object.assign(Object.create(md) as MarkdownIt, {
    core: gatedChain(md.core as unknown as Chain),
    block: gatedChain(md.block as unknown as Chain),
    inline: gatedChain(md.inline as unknown as Chain),
  });
}
