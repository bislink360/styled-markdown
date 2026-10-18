import { alertCallout } from './alerts';
import { markdownForV2 } from './migrate';
import { parseSmd } from './parse';
import { SMD_VERSION } from './spec';

/**
 * Upgrade plain Markdown: add front matter with `smd: 2` (SMD_VERSION) and turn GitHub alerts into callouts. Spec v2
 * shows text as GitHub does (no typographic replacements, only GFM autolinks, a heading's `{word}` as text); the few
 * places where it would read the Markdown otherwise than v1 (and GitHub) do are rewritten (markdownForV2).
 */
export function markdownToSmd(md: string, fallbackTitle: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // The marker in any case, as GitHub reads it; the same callouts as rendering gives alerts.
    const callout = lines[i].startsWith('>') ? alertCallout(lines[i].slice(1).trim()) : undefined;
    if (!callout) { out.push(lines[i]); continue; }
    out.push(`:::${callout}`);
    while (i + 1 < lines.length && /^>/.test(lines[i + 1])) out.push(lines[++i].replace(/^>\s?/, ''));
    out.push(':::');
  }
  let body = out.join('\n');
  if (/^---\r?\n/.test(body)) {
    // Front matter that already says which version reads it keeps it, and its text stays as written.
    if (/^smd\s*:/m.test(body.split(/\r?\n---/)[0])) return withoutHeadingAnchors(body);
    return withoutHeadingAnchors(markdownForV2(body).replace(/^---\r?\n/, `---\nsmd: ${SMD_VERSION}\n`));
  }
  // The Markdown is read with the v1 rules until it says smd: 2: keep that reading (see markdownForV2).
  body = markdownForV2(body);
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = h1 ? h1[1].trim() : fallbackTitle;
  if (h1) body = body.replace(h1[0] + '\n', '').replace(/^\s*\n/, '');
  const today = new Date().toISOString().slice(0, 10);
  return withoutHeadingAnchors(`---\nsmd: ${SMD_VERSION}\ntitle: ${JSON.stringify(title)}\nstatus: draft\nupdated: ${today}\n---\n\n${body}`);
}

/** An anchor line as `smd to-md` writes it before a heading. */
const HEADING_ANCHOR = /^<a id="([^"]*)"><\/a>$/;

/**
 * Drop the `<a id="…"></a>` lines `smd to-md` writes before headings whose GitHub id differs from their own:
 * an anchor line right before a heading (or before a blank line and a heading) whose id is that heading's id
 * anyway. Any other anchor stays, so no id is lost.
 */
function withoutHeadingAnchors(smd: string): string {
  const lines = smd.split('\n');
  if (!lines.some((l) => HEADING_ANCHOR.test(l))) return smd;
  const ids = new Map(parseSmd(smd).headings.map((h) => [h.line, h.slug]));
  const drop = new Set<number>();
  lines.forEach((line, i) => {
    const m = HEADING_ANCHOR.exec(line);
    if (!m) return;
    const id = m[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    if (ids.get(i + 1) === id) drop.add(i);
    else if (lines[i + 1] === '' && ids.get(i + 2) === id) drop.add(i).add(i + 1);
  });
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** Fill a template's {{title}} and {{today}} placeholders. */
export function fillTemplate(text: string, title: string, today = new Date().toISOString().slice(0, 10)): string {
  return text.replace(/\{\{title\}\}/g, title.replace(/"/g, "'")).replace(/\{\{today\}\}/g, today);
}
