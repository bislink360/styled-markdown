import { dirOf, outsideCode, rebaseFenceFile, rebaseUrl, shiftedLevel, type IncludeSource, type LoadedInclude } from './include';
import { findLinks } from './links';
import { parseSmd } from './parse';

/** `:::include` for the line-based views (agent view, plain Markdown, validation), which read text rather than tokens. */

/** Read includes through `readFile`, finding sections by the headings parseSmd gives. */
export function includeSource(readFile: ((relativePath: string) => string | undefined) | undefined): IncludeSource {
  return { readFile, headings: (text) => parseSmd(text).headings };
}

/**
 * The lines of an included file as the including document reads them (same indexes): headings moved by its
 * `level`, and relative links, images and code embeds rebased onto the including document's folder.
 */
export function includedLines(include: LoadedInclude): string[] {
  const lines = [...include.lines];
  const dir = dirOf(include.path);
  if (dir) rebaseLinks(lines, dir);
  for (const [i, fence] of outsideCode(lines, include.start, include.end)) {
    lines[i] = fence ? rebaseFenceFile(lines[i], dir) : shiftHeading(lines[i], include.shift);
  }
  return lines;
}

/** Links, images, reference definitions and HTML href/src; `:::include` paths stay, as nested includes resolve them. */
function rebaseLinks(lines: string[], dir: string): void {
  const links = findLinks(lines.join('\n')).links
    .filter((l) => l.kind !== 'related' && l.kind !== 'include')
    .sort((a, b) => b.line - a.line || b.column - a.column);
  for (const link of links) {
    const line = lines[link.line];
    lines[link.line] = line.slice(0, link.column) + rebaseUrl(link.target, dir) + line.slice(link.column + link.target.length);
  }
}

function shiftHeading(line: string, shift: number): string {
  if (!shift) return line;
  const m = /^(\s{0,3})(#{1,6})(?=\s|$)/.exec(line);
  return m ? m[1] + '#'.repeat(shiftedLevel(m[2].length, shift)) + line.slice(m[0].length) : line;
}
