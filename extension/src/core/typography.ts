import type MarkdownIt from 'markdown-it';
import type { StateCore } from 'markdown-it';
import { isV2, type SpecEnv } from './specVersion';
import { own } from './util';

/**
 * Spec v2's text rules (RFC proposal 8, docs/SPEC.md §4.8), for every markdown-it instance the .smd rules are on:
 * renderSmd's, the plugin's hosts', the exporters' and the Block Editor's.
 *
 * - **Typography:** no typographic replacements (curly quotes, `–` and `—` from `--` and `---`, `…`, `©`, `™`, `®`,
 *   `±`) unless the front matter says `typography: true`.
 * - **Links:** only GFM autolink literals become links: `http://`, `https://` and `ftp://` URLs, `mailto:`, `www.`
 *   (linked as `http://www.…`) and e-mail addresses. A bare domain (`example.com`, `README.md`), a protocol-relative
 *   `//host` and `WWW.` in capitals are text. `typography: true` doesn't change links.
 *
 * Spec v1 documents keep the instance's own settings: renderSmd's typographer and fuzzy links, a host's options.
 *
 * markdown-it options belong to an instance, while the version and front matter belong to one render, so two core
 * rules switch them for each render of a v2 document: `smd_text_rules`, before the core `linkify` rule, turns the
 * typographer off (unless the document says `typography: true`) and puts a GFM linkifier in place; `smd_text_rules_end`,
 * after `smartquotes`, puts the instance's own back. Only those rules run between them, so no other render sees the
 * switch. The rules only take away: a host whose typographer or linkify is off keeps it off (Obsidian's typographer).
 * Scheme URLs are linked during inline parsing by the instance's own linkifier, the same way in either version.
 */

/** The front matter key that turns typography on in spec v2. */
export const TYPOGRAPHY_KEY = 'typography';

/** Whether front matter turns typography on: `typography: true` (a boolean; other values don't). */
export function typographyOf(data: Readonly<Record<string, unknown>> | undefined): boolean {
  return data !== undefined && own(data, TYPOGRAPHY_KEY) === true;
}

/**
 * Whether the render `env` belongs to may make typographic replacements: always in spec v1 (as the instance is set),
 * and in spec v2 only with `typography: true`.
 */
export function typographyOn(env: unknown): boolean {
  return !isV2(env) || (env as SpecEnv | null | undefined)?.smdTypography === true;
}

type Linkify = MarkdownIt['linkify'];
/** The instance fields the rules switch (markdown-it types `linkify` read-only). */
type Switchable = { options: MarkdownIt['options']; linkify: Linkify };

/** The instance's own settings while a v2 render runs the core linkify and typographer rules. */
const saved = new WeakMap<StateCore, { typographer: boolean | undefined; linkify: Linkify }>();

/** Add the rules that read v2 documents' text with spec v2's typography and links. */
export function addTextRules(md: MarkdownIt): void {
  md.core.ruler.before('linkify', 'smd_text_rules', (state) => {
    if (!isV2(state.env)) return;
    const m = state.md as unknown as Switchable;
    saved.set(state, { typographer: m.options.typographer, linkify: m.linkify });
    if (!typographyOn(state.env)) m.options.typographer = false;
    m.linkify = gfmLinkify(m.linkify);
  });
  md.core.ruler.after('smartquotes', 'smd_text_rules_end', (state) => {
    const kept = saved.get(state);
    if (!kept) return;
    saved.delete(state);
    const m = state.md as unknown as Switchable;
    m.options.typographer = kept.typographer;
    m.linkify = kept.linkify;
  });
}

// ---------------------------------------------------------------------------
// GFM autolink literals
// ---------------------------------------------------------------------------

/** One GFM linkifier per linkify-it class: a host's own copy of linkify-it gets one of its own. */
const GFM = new WeakMap<object, Linkify>();

/** The GFM linkifier made with the class of `like` (so the plugin needs no linkify-it of its own). */
export function gfmLinkify(like: Linkify): Linkify {
  const Make = like.constructor as new () => Linkify;
  let gfm = GFM.get(Make);
  if (!gfm) {
    gfm = gfmAutolinks(new Make());
    GFM.set(Make, gfm);
  }
  return gfm;
}

const WWW = 'www.';

/**
 * linkify-it set to GFM's autolink literals: no fuzzy links (a domain without a scheme), e-mail addresses kept,
 * `//host` removed, and `www.` added as a scheme that must be written in lower case, as GitHub has it.
 */
function gfmAutolinks(linkify: Linkify): Linkify {
  return linkify
    .set({ fuzzyLink: false, fuzzyEmail: true, fuzzyIP: false })
    .add('//', null)
    .add(WWW, {
      validate: wwwLength,
      normalize: (match) => {
        match.url = `http://${match.url}`;
      },
    });
}

/** linkify-it's own patterns for a host (with an optional port) and a path. */
const HOSTS = new WeakMap<object, RegExp>();

/** The length of the host and path after `www.` at `pos` (0: not a link). */
function wwwLength(text: string, pos: number, self: Linkify): number {
  if (text.slice(pos - WWW.length, pos) !== WWW) return 0;
  let host = HOSTS.get(self);
  if (!host) {
    const re = (self as unknown as { re: Record<string, string> }).re;
    host = new RegExp(`^${re.src_host_port_strict}${re.src_path}`, 'i');
    HOSTS.set(self, host);
  }
  return host.exec(text.slice(pos))?.[0].length ?? 0;
}
