import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG_FILES, loadRuleConfig, type LoadedConfig } from './config';
import { readerFor } from './files';
import {
  CONTAINERS, FRONTMATTER_KEYS, INLINE_DIRECTIVES, NAMED_COLORS, SIZE_VALUES, STATUS_VALUES, AUDIENCE_VALUES,
  STYLE_KEYS, WEIGHT_VALUES, FONT_VALUES, ALIGN_VALUES, TEXT_STYLE_VALUES, MERMAID_TYPES,
  formatSmd, parseFrontMatter, renderSmd, validateSmd, type Diagnostic,
} from './core';
import {
  anchorLine, anchorTargets, isDocumentPath, linkAt, linkCompletionContext, splitTarget, type LinkCompletionContext,
} from './core/links';
import { encodeAnchor, headingAt, linksToAnchor, renameHeading } from './core/anchors';

const SELECTOR: vscode.DocumentSelector = { language: 'smd' };

// ---------------------------------------------------------------------------
// Diagnostics + quick fixes
// ---------------------------------------------------------------------------

const SEVERITY: Record<Diagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** Keeps the core diagnostic (with its fix) next to the VS Code one. */
const fixes = new WeakMap<vscode.Diagnostic, NonNullable<Diagnostic['fix']>>();

export class SmdDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('smd');
  /** Problems in smd.config.json / .smdrc files, shown on those files. */
  private readonly configProblems = vscode.languages.createDiagnosticCollection('smd-config');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private configs = new Map<string, LoadedConfig>();

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/{${CONFIG_FILES.join(',')}}`);
    const reload = () => {
      this.configs = new Map();
      this.configProblems.clear();
      vscode.workspace.textDocuments.forEach((d) => this.update(d));
    };
    this.disposables.push(
      watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload),
      vscode.workspace.onDidOpenTextDocument((d) => this.update(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('smd.validation')) vscode.workspace.textDocuments.forEach((d) => this.update(d));
      }),
    );
    vscode.workspace.textDocuments.forEach((d) => this.update(d));
  }

  schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.update(document), 300));
  }

  update(document: vscode.TextDocument): number {
    if (document.languageId !== 'smd') return 0;
    const config = vscode.workspace.getConfiguration('smd.validation', document.uri);
    if (!config.get<boolean>('enabled', true)) {
      this.collection.delete(document.uri);
      return 0;
    }
    const dir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    const fileExists = dir && config.get<boolean>('checkLinks', true)
      ? (rel: string) => fs.existsSync(path.resolve(dir, rel))
      : undefined;
    const rules = document.uri.scheme === 'file' ? this.rulesFor(document.uri.fsPath) : undefined;
    const items = validateSmd(document.getText(), { fileExists, readFile: readerFor(document), rules }).map((d) => {
      const range = new vscode.Range(d.line, d.column, d.line, d.endColumn);
      const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
      diag.source = 'smd';
      diag.code = d.code;
      if (d.fix) fixes.set(diag, d.fix);
      return diag;
    });
    this.collection.set(document.uri, items);
    return items.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
  }

  /** Rule settings from the nearest config file; its problems are shown on the config file. */
  private rulesFor(file: string) {
    const config = loadRuleConfig(file, this.configs);
    if (config.file && config.problems.length) {
      this.configProblems.set(vscode.Uri.file(config.file), config.problems.map((p) => {
        const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), p, vscode.DiagnosticSeverity.Warning);
        diag.source = 'smd';
        return diag;
      }));
    }
    return config.rules;
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.collection.dispose();
    this.configProblems.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

class QuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      const fix = fixes.get(diag);
      if (!fix) continue;
      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, new vscode.Range(fix.line, fix.column, fix.line, fix.endColumn), fix.replacement);
      action.diagnostics = [diag];
      action.isPreferred = true;
      actions.push(action);
    }
    return actions;
  }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

const ATTR_VALUES: Record<string, string[]> = {
  color: [...NAMED_COLORS],
  bg: [...NAMED_COLORS],
  border: [...NAMED_COLORS],
  accent: [...NAMED_COLORS],
  size: Object.keys(SIZE_VALUES),
  weight: Object.keys(WEIGHT_VALUES),
  font: Object.keys(FONT_VALUES),
  align: ALIGN_VALUES,
  style: Object.keys(TEXT_STYLE_VALUES),
  collapsible: ['open'],
};

/**
 * Paths and `#anchors` for links, `related:` entries and `file="…"` embeds. Paths are relative to the
 * document; after `#` the headings and ids of the current or linked document are offered.
 */
function linkCompletions(document: vscode.TextDocument, position: vscode.Position, ctx: LinkCompletionContext): vscode.CompletionItem[] {
  const hash = ctx.kind === 'embed' ? -1 : ctx.target.indexOf('#');
  const dir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;

  if (hash >= 0) {
    const rel = ctx.target.slice(0, hash);
    let text: string | undefined;
    if (!rel) text = document.getText();
    else if (dir && isDocumentPath(rel)) text = readDocument(path.resolve(dir, decodePath(rel)));
    if (text === undefined) return [];
    const range = new vscode.Range(position.line, ctx.column + hash + 1, position.line, position.character);
    return anchorItems(text, range, '');
  }

  const items: vscode.CompletionItem[] = [];
  const slash = ctx.target.lastIndexOf('/');
  const range = new vscode.Range(position.line, ctx.column + slash + 1, position.line, position.character);
  if (dir) {
    const folder = path.resolve(dir, decodePath(ctx.target.slice(0, slash + 1)));
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { /* no such folder */ }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (path.join(folder, entry.name) === document.uri.fsPath) continue;
      const isDir = entry.isDirectory();
      const isDoc = !isDir && isDocumentPath(entry.name);
      if (ctx.kind === 'related' && !isDir && !isDoc) continue;
      const name = ctx.kind === 'link' ? entry.name.replace(/ /g, '%20') : entry.name;
      const item = new vscode.CompletionItem(isDir ? `${entry.name}/` : entry.name, isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
      item.range = range;
      item.insertText = isDir ? `${name}/` : name;
      item.sortText = `${isDoc ? 0 : isDir ? 1 : 2}${entry.name.toLowerCase()}`;
      if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest files' };
      items.push(item);
    }
  }
  // An empty link target can also point into this document.
  if (ctx.kind === 'link' && ctx.target === '') items.push(...anchorItems(document.getText(), range, '#'));
  return items;
}

function anchorItems(text: string, range: vscode.Range, prefix: string): vscode.CompletionItem[] {
  return anchorTargets(text).map((t, i) => {
    const item = new vscode.CompletionItem(`${prefix}${t.id}`, vscode.CompletionItemKind.Reference);
    item.range = range;
    item.detail = t.text !== undefined ? `${'#'.repeat(t.level ?? 1)} ${t.text}` : t.line !== undefined ? `id on line ${t.line + 1}` : 'id';
    item.sortText = `3${String(i).padStart(5, '0')}`;
    return item;
  });
}

/** The open (possibly unsaved) version of a file, or its contents on disk. */
function readDocument(file: string): string | undefined {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
  if (open) return open.getText();
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

class CompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const prefix = document.lineAt(position.line).text.slice(0, position.character);
    const link = linkCompletionContext(document.getText(), position.line, position.character);
    if (link) return linkCompletions(document, position, link);
    const fm = parseFrontMatter(document.getText());

    // Front matter keys and values
    if (fm.present && position.line > 0 && position.line < fm.bodyStartLine - 1) {
      const value = /^(status|audience|theme|accent):\s*(\w*)$/.exec(prefix);
      if (value) {
        const options = value[1] === 'status' ? STATUS_VALUES : value[1] === 'audience' ? AUDIENCE_VALUES
          : value[1] === 'theme' ? ['auto', 'light', 'dark'] : [...NAMED_COLORS];
        return options.map((o) => new vscode.CompletionItem(o, vscode.CompletionItemKind.EnumMember));
      }
      if (/^\w*$/.test(prefix)) {
        return Object.entries(FRONTMATTER_KEYS).map(([key, doc]) => {
          const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
          item.insertText = `${key}: `;
          item.documentation = doc;
          return item;
        });
      }
      return undefined;
    }

    // Inside an attribute list: {key=value …
    const brace = prefix.lastIndexOf('{');
    if (brace > prefix.lastIndexOf('}')) {
      const inside = prefix.slice(brace + 1);
      const valueMatch = /([\w-]+)=["']?([^\s"'=]*)$/.exec(inside);
      if (valueMatch) {
        const owner = /^\s*:{3,}\s*([\w-]+)\{/.exec(prefix)?.[1];
        const directiveName = /:([a-z][\w-]*)(?:\[[^\]]*\])?\{[^}]*$/.exec(prefix)?.[1];
        const specValues = (owner && CONTAINERS[owner]?.values?.[valueMatch[1]])
          ?? (directiveName && INLINE_DIRECTIVES[directiveName]?.values?.[valueMatch[1]]);
        return (specValues || ATTR_VALUES[valueMatch[1]] || []).map((v) => {
          const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
          if (NAMED_COLORS.includes(v as never)) item.kind = vscode.CompletionItemKind.Color;
          return item;
        });
      }
      const container = /^\s*:{3,}\s*([\w-]+)\{/.exec(prefix);
      const directive = /:([a-z][\w-]*)(?:\[[^\]]*\])?\{[^}]*$/.exec(prefix);
      let keys: string[] = Object.keys(STYLE_KEYS);
      if (container && CONTAINERS[container[1]]) keys = [...(CONTAINERS[container[1]].attrs ?? []), ...keys];
      else if (directive && INLINE_DIRECTIVES[directive[1]]) keys = INLINE_DIRECTIVES[directive[1]].attrs;
      return keys.map((k) => {
        const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
        item.insertText = new vscode.SnippetString(`${k}=$0`);
        item.documentation = STYLE_KEYS[k];
        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
        return item;
      });
    }

    // Container names after :::
    const open = /^\s*(:{3,})\s*([\w-]*)$/.exec(prefix);
    if (open) {
      return Object.entries(CONTAINERS).map(([name, spec], i) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
        item.documentation = new vscode.MarkdownString(spec.description);
        item.sortText = String(i).padStart(2, '0');
        const colons = open[1];
        if (name === 'tabs') item.insertText = new vscode.SnippetString(`tabs\n${colons}tab \${1:First}\n$0\n${colons}\n${colons}tab \${2:Second}\n\n${colons}\n`);
        else if (name === 'columns') item.insertText = new vscode.SnippetString(`columns\n${colons}column\n$0\n${colons}\n${colons}column\n\n${colons}\n`);
        else item.insertText = new vscode.SnippetString(`${name}${spec.title ? ' ${1}' : ''}\n$0\n${colons}`);
        return item;
      });
    }

    // Diagram / code languages after ```
    if (/^\s*(`{3,}|~{3,})\w*$/.test(prefix)) {
      return ['mermaid', 'math', 'ts', 'js', 'json', 'yaml', 'bash', 'python', 'go', 'sql', 'diff'].map((l) =>
        new vscode.CompletionItem(l, l === 'mermaid' || l === 'math' ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Value));
    }

    // Inline directives :name
    const inline = /(?:^|[\s(>*_-]):([a-z]*)$/.exec(prefix);
    if (inline) {
      const range = new vscode.Range(position.translate(0, -inline[1].length), position);
      return Object.entries(INLINE_DIRECTIVES).map(([name, spec]) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.range = range;
        item.detail = spec.example;
        item.documentation = spec.description;
        const color = `{color=\${2|${NAMED_COLORS.join(',')}|}}`;
        item.insertText = new vscode.SnippetString(
          name === 'progress' ? 'progress{value=${1:50}}'
            : name === 'kbd' ? 'kbd[${1:Ctrl+S}]'
            : name === 'mention' ? 'mention[${1:@team}]'
            : `${name}[\${1:text}]${color}`,
        );
        return item;
      });
    }

    // Mermaid diagram types on the first line of a mermaid fence
    if (position.line > 0 && /^\s*```\s*mermaid/.test(document.lineAt(position.line - 1).text) && /^\s*\w*$/.test(prefix)) {
      return MERMAID_TYPES.map((t) => new vscode.CompletionItem(t, vscode.CompletionItemKind.Keyword));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

class HoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    const container = /^(\s*:{3,}\s*)([\w-]+)/.exec(line);
    if (container) {
      const start = container[1].length;
      const end = start + container[2].length;
      const spec = CONTAINERS[container[2]];
      if (spec && position.character >= start && position.character <= end) {
        const attrs = spec.attrs?.length ? `\n\nAttributes: \`${spec.attrs.join('`, `')}\` + style attributes` : '';
        return new vscode.Hover(new vscode.MarkdownString(`**:::${container[2]}** — ${spec.description}${attrs}`),
          new vscode.Range(position.line, start, position.line, end));
      }
    }
    const range = document.getWordRangeAtPosition(position, /:[a-z][\w-]*/);
    if (range) {
      const name = document.getText(range).slice(1);
      const spec = INLINE_DIRECTIVES[name];
      if (spec) return new vscode.Hover(new vscode.MarkdownString(`**:${name}** — ${spec.description}\n\n\`${spec.example}\``), range);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Color swatches for color=… / bg=… / accent: …
// ---------------------------------------------------------------------------

const LIGHT_HEX: Record<string, string> = {
  red: '#dc2626', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', green: '#16a34a', teal: '#0d9488',
  cyan: '#0891b2', blue: '#2563eb', indigo: '#4f46e5', purple: '#9333ea', pink: '#db2777', gray: '#6b7280',
};

function hexToColor(hex: string): vscode.Color | undefined {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return undefined;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return new vscode.Color(n(0), n(2), n(4), h.length === 8 ? n(6) : 1);
}

class ColorProvider implements vscode.DocumentColorProvider {
  provideDocumentColors(document: vscode.TextDocument): vscode.ColorInformation[] {
    const out: vscode.ColorInformation[] = [];
    const re = /\b(?:color|bg|border|accent)\s*[=:]\s*["']?(#[0-9a-fA-F]{3,8}|[a-z]+)\b/g;
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      for (const m of text.matchAll(re)) {
        const value = m[1];
        const color = value.startsWith('#') ? hexToColor(value) : LIGHT_HEX[value] ? hexToColor(LIGHT_HEX[value]) : undefined;
        if (!color) continue;
        const start = m.index! + m[0].lastIndexOf(value);
        out.push(new vscode.ColorInformation(new vscode.Range(i, start, i, start + value.length), color));
      }
    }
    return out;
  }

  provideColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
    const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
    const value = `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}${color.alpha < 1 ? hex(color.alpha) : ''}`;
    // Hex needs quotes inside attribute lists only when followed by other characters; quoting is always safe.
    return [new vscode.ColorPresentation(`"${value}"`), new vscode.ColorPresentation(value)];
  }
}

// ---------------------------------------------------------------------------
// Outline + folding
// ---------------------------------------------------------------------------

class SymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const headings = renderSmd(document.getText()).headings;
    const roots: vscode.DocumentSymbol[] = [];
    const stack: Array<{ level: number; symbol: vscode.DocumentSymbol }> = [];
    headings.forEach((h, i) => {
      const next = headings.slice(i + 1).find((n) => n.level <= h.level);
      const endLine = Math.max(h.line, (next ? next.line : document.lineCount) - 1);
      const range = new vscode.Range(h.line, 0, endLine, document.lineAt(endLine).text.length);
      const symbol = new vscode.DocumentSymbol(h.text || '(untitled)', `H${h.level}`, vscode.SymbolKind.String, range, document.lineAt(h.line).range);
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      if (stack.length) stack[stack.length - 1].symbol.children.push(symbol); else roots.push(symbol);
      stack.push({ level: h.level, symbol });
    });
    return roots;
  }
}

class FoldingProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const ranges: vscode.FoldingRange[] = [];
    const stack: number[] = [];
    let fence = -1;
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (/^\s{0,3}(`{3,}|~{3,})/.test(text)) {
        if (fence === -1) fence = i; else { ranges.push(new vscode.FoldingRange(fence, i)); fence = -1; }
        continue;
      }
      if (fence !== -1) continue;
      if (/^\s{0,3}:{3,}\s*[a-zA-Z]/.test(text)) stack.push(i);
      else if (/^\s{0,3}:{3,}\s*$/.test(text) && stack.length) ranges.push(new vscode.FoldingRange(stack.pop()!, i));
    }
    const fm = parseFrontMatter(document.getText());
    if (fm.present && fm.bodyStartLine > 1) ranges.push(new vscode.FoldingRange(0, fm.bodyStartLine - 1, vscode.FoldingRangeKind.Region));
    return ranges;
  }
}

// ---------------------------------------------------------------------------
// Go to definition: links to headings, anchors in other documents, files and reference definitions
// ---------------------------------------------------------------------------

class DefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink[] | undefined {
    const text = document.getText();
    const hit = linkAt(text, position.line, position.character);
    if (!hit) return undefined;
    const origin = new vscode.Range(position.line, hit.start, position.line, hit.end);
    const at = (uri: vscode.Uri, line: number): vscode.LocationLink[] => {
      const range = new vscode.Range(line, 0, line, 0);
      return [{ originSelectionRange: origin, targetUri: uri, targetRange: range, targetSelectionRange: range }];
    };

    // A reference `[text][label]` jumps to its `[label]: …` definition.
    if (hit.reference) return at(document.uri, hit.link.line);

    const parts = splitTarget(hit.link.target);
    if (!parts) return undefined;
    if (!parts.path) {
      const line = parts.anchor ? anchorLine(text, parts.anchor) : undefined;
      return line === undefined ? undefined : at(document.uri, line);
    }
    if (document.uri.scheme !== 'file') return undefined;
    const target = vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), parts.path));
    if (!fs.existsSync(target.fsPath)) return undefined;
    if (!parts.anchor || !isDocumentPath(parts.path)) return at(target, 0);
    // Prefer the open (possibly unsaved) version of the target document.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
    let other: string | undefined = open?.getText();
    if (other === undefined) {
      try { other = fs.readFileSync(target.fsPath, 'utf8'); } catch { return undefined; }
    }
    return at(target, anchorLine(other, parts.anchor) ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Find references and rename for heading anchors, across the workspace
// ---------------------------------------------------------------------------

interface WorkspaceDoc { uri: vscode.Uri; text: string }

/** Every .smd / .md document in the workspace (open ones with their unsaved text), plus `current`. */
async function workspaceDocuments(current: vscode.TextDocument): Promise<WorkspaceDoc[]> {
  const uris = await vscode.workspace.findFiles('**/*.{smd,md,markdown}', '**/node_modules/**');
  const docs = new Map<string, WorkspaceDoc>();
  for (const uri of [current.uri, ...uris]) {
    const key = uri.toString();
    if (docs.has(key)) continue;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) { docs.set(key, { uri, text: open.getText() }); continue; }
    try { docs.set(key, { uri, text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') }); } catch { /* unreadable */ }
  }
  return [...docs.values()];
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Does a link path written in `from` point at `target`? An empty path is the document itself. */
function pointsAt(from: vscode.Uri, linkPath: string, target: vscode.Uri): boolean {
  if (!linkPath) return from.toString() === target.toString();
  if (from.scheme !== 'file' || target.scheme !== 'file') return false;
  return samePath(path.resolve(path.dirname(from.fsPath), linkPath), target.fsPath);
}

/** The anchor at a position: a heading, or the `#anchor` of a link to an existing document. */
function anchorAt(document: vscode.TextDocument, position: vscode.Position): { uri: vscode.Uri; id: string } | undefined {
  const text = document.getText();
  const heading = headingAt(text, position.line);
  if (heading) return { uri: document.uri, id: heading.slug };
  const hit = linkAt(text, position.line, position.character);
  const parts = hit && !hit.reference ? splitTarget(hit.link.target) : undefined;
  if (!parts?.anchor) return undefined;
  if (!parts.path) return { uri: document.uri, id: parts.anchor };
  if (document.uri.scheme !== 'file' || !isDocumentPath(parts.path)) return undefined;
  const target = path.resolve(path.dirname(document.uri.fsPath), parts.path);
  return fs.existsSync(target) ? { uri: vscode.Uri.file(target), id: parts.anchor } : undefined;
}

class ReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
    const anchor = anchorAt(document, position);
    if (!anchor) return [];
    const docs = await workspaceDocuments(document);
    const locations: vscode.Location[] = [];
    if (context.includeDeclaration) {
      const target = docs.find((d) => d.uri.toString() === anchor.uri.toString());
      const line = target ? anchorLine(target.text, anchor.id) : undefined;
      if (target && line !== undefined) {
        const h = headingAt(target.text, line);
        locations.push(new vscode.Location(anchor.uri, new vscode.Range(line, h?.start ?? 0, line, h?.end ?? 0)));
      }
    }
    for (const doc of docs) {
      for (const l of linksToAnchor(doc.text, anchor.id, (p) => pointsAt(doc.uri, p, anchor.uri))) {
        locations.push(new vscode.Location(doc.uri, new vscode.Range(l.line, l.column, l.line, l.endColumn)));
      }
    }
    return locations;
  }
}

class RenameProvider implements vscode.RenameProvider {
  prepareRename(document: vscode.TextDocument, position: vscode.Position): { range: vscode.Range; placeholder: string } {
    const heading = headingAt(document.getText(), position.line);
    if (!heading) throw new Error('Rename a heading to update every link to it.');
    return { range: new vscode.Range(heading.line, heading.start, heading.line, heading.end), placeholder: heading.text };
  }

  async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit | undefined> {
    const text = document.getText();
    const heading = headingAt(text, position.line);
    const renamed = heading && renameHeading(text, position.line, newName);
    if (!heading || !renamed) return undefined;
    const edit = new vscode.WorkspaceEdit();
    const headingRange = new vscode.Range(heading.line, heading.start, heading.line, heading.end);
    edit.replace(document.uri, headingRange, renamed.lineText.slice(heading.start, renamed.lineText.length - (text.split(/\r?\n/)[heading.line].length - heading.end)));
    if (!renamed.changes.length) return edit;
    for (const doc of await workspaceDocuments(document)) {
      for (const { from, to } of renamed.changes) {
        for (const l of linksToAnchor(doc.text, from, (p) => pointsAt(doc.uri, p, document.uri))) {
          // A link inside the renamed heading text is replaced along with it.
          if (doc.uri.toString() === document.uri.toString() && headingRange.contains(new vscode.Position(l.line, l.column))) continue;
          edit.replace(doc.uri, new vscode.Range(l.line, l.column, l.line, l.endColumn), encodeAnchor(l.raw, to));
        }
      }
    }
    return edit;
  }
}

// ---------------------------------------------------------------------------
// Formatting (Format Document, format on save): the same rules as `smd fmt`
// ---------------------------------------------------------------------------

class FormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const text = document.getText();
    const formatted = formatSmd(text);
    if (formatted === text) return [];
    // Replace only the changed lines, so the cursor and folds elsewhere stay put.
    const before = text.split(/\r?\n/);
    const after = formatted.split(/\r?\n/);
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const changed = after.slice(start, after.length - end).join(eol);
    // Up to the first unchanged line, or through the end of the document when the change reaches it.
    if (end > 0) return [vscode.TextEdit.replace(new vscode.Range(start, 0, before.length - end, 0), changed + (after.length - end > start ? eol : ''))];
    const from = Math.min(start, document.lineCount - 1);
    return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(from, 0), document.lineAt(document.lineCount - 1).range.end), after.slice(from).join(eol))];
  }
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): SmdDiagnostics {
  const diagnostics = new SmdDiagnostics();
  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerCodeActionsProvider(SELECTOR, new QuickFixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(SELECTOR, new CompletionProvider(), ':', '{', '=', ' ', '`', '(', '/', '#', '"'),
    vscode.languages.registerHoverProvider(SELECTOR, new HoverProvider()),
    vscode.languages.registerColorProvider(SELECTOR, new ColorProvider()),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new SymbolProvider()),
    vscode.languages.registerFoldingRangeProvider(SELECTOR, new FoldingProvider()),
    vscode.languages.registerDefinitionProvider(SELECTOR, new DefinitionProvider()),
    vscode.languages.registerReferenceProvider(SELECTOR, new ReferenceProvider()),
    vscode.languages.registerRenameProvider(SELECTOR, new RenameProvider()),
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, new FormattingProvider()),
  );
  return diagnostics;
}
