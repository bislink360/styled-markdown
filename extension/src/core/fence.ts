/**
 * Code fence info strings:
 *   ```ts title="src/app.ts" {2,5-7}
 *   ```ts file="../src/app.ts" lines="10-24" {3}
 */
export interface FenceInfo {
  lang: string;
  title?: string;
  /** Path of a file whose contents replace the fence body. */
  file?: string;
  /** 1-based inclusive line range of `file` to embed. */
  lines?: [number, number];
  /** Raw `lines` value, kept for error messages. */
  linesRaw?: string;
  /** 1-based line numbers to highlight. */
  highlight: Set<number>;
  /** Problems found while parsing (bad ranges). */
  problems: string[];
}

export function parseFenceInfo(info: string): FenceInfo {
  const trimmed = info.trim();
  const lang = /^[^\s{]*/.exec(trimmed)![0];
  const rest = trimmed.slice(lang.length);
  const result: FenceInfo = { lang, highlight: new Set(), problems: [] };
  const attr = (key: string) => {
    const m = new RegExp(`\\b${key}=(?:"([^"]*)"|'([^']*)'|([^\\s{}]+))`).exec(rest);
    return m ? m[1] ?? m[2] ?? m[3] : undefined;
  };
  result.title = attr('title');
  result.file = attr('file');
  const lines = attr('lines');
  if (lines !== undefined) {
    result.linesRaw = lines;
    const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : start;
      if (start >= 1 && end >= start) result.lines = [start, end];
      else result.problems.push(`Invalid line range "${lines}".`);
    } else {
      result.problems.push(`Invalid line range "${lines}". Use "10-20" or "12".`);
    }
  }
  const hl = /\{([\d,\s-]+)\}/.exec(rest);
  if (hl) {
    for (const part of hl[1].split(',').map((p) => p.trim()).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) { result.problems.push(`Invalid highlight range "${part}".`); continue; }
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let i = a; i <= Math.min(b, a + 5000); i++) result.highlight.add(i);
    }
  }
  return result;
}

/** Language guess from a file extension, for embedded files without an explicit language. */
export function langFromPath(path: string): string {
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'python', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'bash', ps1: 'powershell', sql: 'sql', yml: 'yaml',
    yaml: 'yaml', json: 'json', md: 'markdown', smd: 'markdown', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', toml: 'ini', ini: 'ini', dockerfile: 'dockerfile',
  };
  return map[ext] ?? '';
}

/** Slice a file's text to an inclusive 1-based line range. */
export function sliceLines(text: string, range?: [number, number]): { text: string; outOfRange: boolean } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (!range) return { text: lines.join('\n') + '\n', outOfRange: false };
  const [start, end] = range;
  return { text: lines.slice(start - 1, end).join('\n') + '\n', outOfRange: start > lines.length || end > lines.length };
}
