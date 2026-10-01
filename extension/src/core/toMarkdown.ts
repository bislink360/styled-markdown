import { parseAttrs } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import {
  containerEnd, includeHref, includeLabel, includePath, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import { includedLines, includeSource } from './includeText';
import { HEADING_ATTRS } from './render';
import { riskMatrixMarkdown } from './risks';

export interface ToMarkdownOptions {
  /**
   * Read files for file="…" code embeds and `:::include` blocks; without it an embed becomes a link only,
   * and an include its fallback body (or a link when it has none).
   */
  readFile?: (relativePath: string) => string | undefined;
}

const TICK = '`';

/**
 * Convert .smd to plain GitHub-flavored Markdown. Styling is dropped but the
 * meaning is kept: callouts become GitHub alerts, tabs become labelled
 * sections, badges become code spans, and so on. Mermaid and math are left
 * untouched because GitHub renders both natively.
 */
export function smdToMarkdown(text: string, options: ToMarkdownOptions = {}): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  interface Frame { len: number; prefix: string; close?: string }
  const stack: Frame[] = [];
  const prefix = () => stack.map((f) => f.prefix).join('');
  const emit = (line: string) => {
    const p = prefix();
    out.push(line.trim() === '' ? p.trimEnd() : p + line);
  };

  let fence: string | null = null;
  let i = 0;

  // Keep front matter verbatim.
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      out.push(...lines.slice(0, end + 1));
      i = end + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      emit(line);
      if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      const info = parseFenceInfo(fenceOpen[3]);
      const marker = fenceOpen[2];
      const isClose = (l: string) => l.trim().startsWith(marker) && l.trim().replace(new RegExp(`^\\${marker[0]}+`), '') === '';
      if (info.file) {
        // GitHub cannot embed files: link to the file and inline its current content when readable.
        let j = i + 1;
        while (j < lines.length && !isClose(lines[j])) j++;
        const range = info.lines ? `#L${info.lines[0]}-L${info.lines[1]}` : '';
        emit(`[${TICK}${info.title ?? info.file}${TICK}](${info.file}${range})`);
        const content = options.readFile?.(info.file);
        if (content !== undefined) {
          emit('');
          emit(marker + info.lang);
          for (const l of sliceLines(content, info.lines).text.replace(/\n$/, '').split('\n')) emit(l);
          emit(marker);
        }
        i = j;
        continue;
      }
      fence = marker;
      if (info.title) { emit(`**${TICK}${info.title}${TICK}**`); emit(''); }
      emit(fenceOpen[1] + marker + info.lang);
      continue;
    }

    const close = CONTAINER_CLOSE.exec(line);
    if (close && stack.length) {
      const frame = stack.pop()!;
      if (frame.close !== undefined) emit(frame.close);
      if (frame.prefix) emit(''); // end the blockquote so the next one doesn't merge into it
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (open && info) {
      const len = open[2].length;
      const title = info.title ? convertInline(info.title) : '';
      const alert = ALERTS[info.name];
      if (alert) {
        emit(`> [!${alert}]`);
        stack.push({ len, prefix: '> ' });
        if (title) emit(`**${title}**`);
        if (title) emit('');
      } else if (info.name === 'agent' || info.name === 'human') {
        const who = info.name === 'agent' ? 'For agents' : 'For humans';
        emit(`> [!NOTE]`);
        stack.push({ len, prefix: '> ' });
        emit(`**${who}${title ? `: ${title}` : ''}**`);
        emit('');
      } else if (info.name === 'decision') {
        const v = info.attrs.values;
        const facts = [v.status ?? 'proposed', v.date, v.owner].filter(Boolean).join(' · ');
        emit('> [!NOTE]');
        stack.push({ len, prefix: '> ' });
        emit(`**Decision (${facts})${title ? `: ${title}` : ''}**`);
        emit('');
      } else if (info.name === 'risk') {
        const v = info.attrs.values;
        const facts = [`impact ${v.impact ?? 'medium'}`, v.likelihood ? `likelihood ${v.likelihood}` : '', v.owner ? `owner ${v.owner}` : '', v.status ?? '']
          .filter(Boolean).join(', ');
        emit(`> [!${v.impact === 'high' || v.impact === 'critical' ? 'CAUTION' : 'WARNING'}]`);
        stack.push({ len, prefix: '> ' });
        emit(`**Risk (${facts})${title ? `: ${title}` : ''}**`);
        emit('');
      } else if (info.name === 'api') {
        const v = info.attrs.values;
        emit(`**${TICK}${(v.method ?? 'GET').toUpperCase()} ${v.path ?? ''}${TICK}**${title ? ` — ${title}` : ''}${v.auth ? ` (auth: ${v.auth})` : ''}`);
        emit('');
        stack.push({ len, prefix: '' });
      } else if (info.name === 'details') {
        emit(`<details${info.attrs.values.open !== undefined ? ' open' : ''}><summary>${title || 'Details'}</summary>`);
        emit('');
        stack.push({ len, prefix: '', close: '\n</details>' });
      } else if (info.name === 'card') {
        stack.push({ len, prefix: '> ' });
        if (title) { emit(`**${title}**`); emit(''); }
      } else if (info.name === 'risk-matrix') {
        for (const l of riskMatrixMarkdown(text, title)) emit(l);
        stack.push({ len, prefix: '' });
      } else if (info.name === 'tab') {
        emit(`**${title || 'Tab'}**`);
        emit('');
        stack.push({ len, prefix: '', close: '' });
      } else if (info.name === 'include') {
        i = includeMarkdown(info, { lines, open: i, options, emit, keepBody: () => stack.push({ len, prefix: '' }) });
      } else {
        // box, tabs, columns, column, steps and unknown containers: keep the content only.
        stack.push({ len, prefix: '' });
      }
      continue;
    }
    emit(convertInline(/^\s{0,3}#{1,6}\s/.test(line) ? line.replace(HEADING_ATTRS, '') : line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The include scope of the converted text, for included documents (the root document has none). */
const includeScopes = new WeakMap<ToMarkdownOptions, IncludeScope>();

interface IncludeAt {
  lines: string[];
  /** The line of the `:::include`. */
  open: number;
  options: ToMarkdownOptions;
  emit: (line: string) => void;
  /** Convert the block's body as content, as for a box. */
  keepBody: () => void;
}

/**
 * `:::include` in plain Markdown, which GitHub can't include: the included text, converted, in place of the block.
 * When it can't be read, the fallback body is kept, after a link to the file when the body is empty. Returns the
 * line to go on after: the closing `:::` when the body is skipped.
 */
function includeMarkdown(info: ContainerInfo, at: IncludeAt): number {
  const { lines, open, options } = at;
  const request = includeRequest(info.attrs.values);
  const scope = includeScopes.get(options) ?? rootScope(lines.join('\n'));
  const end = containerEnd(lines, open);
  const result = request && loadInclude(request, scope, includeSource(options.readFile));
  if (result?.ok) {
    const inc = result.include;
    const child: ToMarkdownOptions = { readFile: options.readFile };
    includeScopes.set(child, innerScope(scope, inc));
    // A leading blank line, so a body that starts with `---` is not taken for front matter.
    const text = ['', ...includedLines(inc).slice(inc.start, inc.end + 1)].join('\n');
    at.emit(`<!-- included from ${includeLabel(inc.path, request?.section)} -->`);
    smdToMarkdown(text, child).split('\n').slice(1).forEach(at.emit);
    return end;
  }
  if (request && !lines.slice(open + 1, end).some((l) => l.trim())) {
    const path = includePath(scope.dir, request.file);
    at.emit(`[${includeLabel(path, request.section)}](${includeHref(path, request.section) ?? path})`);
  }
  at.keepBody();
  return open;
}

const ALERTS: Record<string, string> = {
  note: 'NOTE', info: 'NOTE', tip: 'TIP', success: 'TIP', question: 'IMPORTANT', warning: 'WARNING', danger: 'CAUTION',
};

const STATUS_EMOJI: Record<string, string> = {
  green: '🟢', teal: '🟢', red: '🔴', pink: '🔴', orange: '🟠', amber: '🟡', yellow: '🟡',
  blue: '🔵', cyan: '🔵', indigo: '🔵', purple: '🟣', gray: '⚪', muted: '⚪',
};

/** Convert inline SMD syntax on one line, leaving code spans untouched. */
export function convertInline(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : convertText(part)))
    .join('');
}

function convertText(s: string): string {
  return s
    .replace(/(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]\n]*)\])?(?:\{([^{}\n]*)\})?/g, (m, pre, name, content = '', rawAttrs = '') => {
      const v = parseAttrs(rawAttrs)?.values ?? {};
      switch (name) {
        case 'badge': return `${pre}\`${content}\``;
        case 'kbd': return `${pre}${content.split('+').map((k: string) => `<kbd>${k.trim()}</kbd>`).join('+')}`;
        case 'mention': return `${pre}${content}`;
        case 'priority': return `${pre}**${content}**`;
        case 'due': return `${pre}📅 ${content}`;
        case 'metric': return `${pre}**${content}**${v.label ? ` ${v.label}` : ''}${v.delta ? ` (${v.delta})` : ''}`;
        case 'status': return `${pre}${STATUS_EMOJI[v.color] ?? '⚪'} ${content}`;
        case 'progress': {
          const n = Math.max(0, Math.min(100, Number(v.value ?? content) || 0));
          const filled = Math.round(n / 10);
          return `${pre}${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${v.label ?? `${Math.round(n)}%`}`;
        }
        default: return m;
      }
    })
    .replace(/(!?)\[([^\]\n]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => {
      if (bang) return m;
      const attrs = parseAttrs(rawAttrs);
      if (!attrs) return m;
      let t = content;
      const style = attrs.values.style ?? '';
      if (attrs.values.weight === 'bold') t = `**${t}**`;
      if (style.includes('italic')) t = `*${t}*`;
      if (style.includes('strike')) t = `~~${t}~~`;
      return t;
    })
    .replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '**$1**');
}
