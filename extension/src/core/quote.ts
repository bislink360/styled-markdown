import { CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { containerEnd, outsideCode } from './include';

/**
 * Quotations: `:::quote{author="Ada Lovelace" source="Notes" cite="https://…"}` with the quoted text as its body.
 * Rendered as `<figure class="smd-quote"><blockquote cite="…">…</blockquote><figcaption>— Author, <cite>Source</cite></figcaption></figure>`.
 */

/** An http(s) URL or a relative one (no scheme, not `//host`); other schemes such as `javascript:` or `data:` are dropped. */
export function quoteCite(value: string | undefined): string | undefined {
  const url = value?.trim();
  if (!url || /[\s<>"]/.test(url) || /^[/\\]{2}/.test(url) || /^\/\\/.test(url)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' ? url : undefined;
}

/** A `:::quote` in the source: its opening line, parsed, and whether its body has any text. */
export interface QuoteBlock {
  line: number;
  info: ContainerInfo;
  empty: boolean;
}

/** Every `:::quote` from line `from` on, outside code. */
export function findQuotes(lines: string[], from = 0): QuoteBlock[] {
  const found: QuoteBlock[] = [];
  for (const [i, fence] of outsideCode(lines, from, lines.length - 1)) {
    const open = fence ? null : CONTAINER_OPEN.exec(lines[i]);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (info?.name !== 'quote') continue;
    const end = containerEnd(lines, i);
    const body = lines.slice(i + 1, end === lines.length - 1 && !/^\s{0,3}:{3,}\s*$/.test(lines[end]) ? end + 1 : end);
    found.push({ line: i, info, empty: body.every((l) => !l.trim()) });
  }
  return found;
}
