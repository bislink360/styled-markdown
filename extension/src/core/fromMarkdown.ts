import { SMD_VERSION } from './spec';

/** Upgrade plain Markdown: add front matter and turn GitHub alerts into callouts. */
export function markdownToSmd(md: string, fallbackTitle: string): string {
  const alertMap: Record<string, string> = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger' };
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const alert = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/.exec(lines[i]);
    if (!alert) { out.push(lines[i]); continue; }
    out.push(`:::${alertMap[alert[1]]}`);
    while (i + 1 < lines.length && /^>/.test(lines[i + 1])) out.push(lines[++i].replace(/^>\s?/, ''));
    out.push(':::');
  }
  let body = out.join('\n');
  if (/^---\r?\n/.test(body)) {
    return /^smd\s*:/m.test(body.split(/\r?\n---/)[0]) ? body : body.replace(/^---\r?\n/, `---\nsmd: ${SMD_VERSION}\n`);
  }
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = h1 ? h1[1].trim() : fallbackTitle;
  if (h1) body = body.replace(h1[0] + '\n', '').replace(/^\s*\n/, '');
  const today = new Date().toISOString().slice(0, 10);
  return `---\nsmd: ${SMD_VERSION}\ntitle: ${JSON.stringify(title)}\nstatus: draft\nupdated: ${today}\n---\n\n${body}`;
}

/** Fill a template's {{title}} and {{today}} placeholders. */
export function fillTemplate(text: string, title: string, today = new Date().toISOString().slice(0, 10)): string {
  return text.replace(/\{\{title\}\}/g, title.replace(/"/g, "'")).replace(/\{\{today\}\}/g, today);
}
