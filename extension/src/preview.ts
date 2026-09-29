import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderSmd, type RenderOptions } from './core';
import { readerFor } from './files';

/** Live preview webviews, one per .smd document. */
export class PreviewManager implements vscode.Disposable {
  private readonly previews = new Map<string, Preview>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.previews.get(e.document.uri.toString())?.scheduleUpdate()),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const preview = this.previews.get(e.textEditor.document.uri.toString());
        const top = e.visibleRanges[0]?.start.line;
        if (preview && top !== undefined) preview.scrollToLine(top);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('smd.preview')) this.previews.forEach((p) => p.update());
      }),
      // Embedded source files (```ts file="…") may have changed.
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.languageId !== 'smd') this.previews.forEach((p) => p.scheduleUpdate());
      }),
    );
  }

  show(document: vscode.TextDocument, toSide: boolean): void {
    const key = document.uri.toString();
    const existing = this.previews.get(key);
    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (existing) {
      existing.panel.reveal(column, true);
      return;
    }
    const preview = new Preview(this.context, document, column, () => this.previews.delete(key));
    this.previews.set(key, preview);
  }

  /** What the webview last reported rendering (diagram/math/error counts). Used by tests. */
  status(uri: string): RenderStatus | undefined {
    return this.previews.get(uri)?.lastStatus;
  }

  dispose(): void {
    this.previews.forEach((p) => p.panel.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}

export function renderOptions(document?: vscode.TextDocument): RenderOptions {
  const config = vscode.workspace.getConfiguration('smd.preview');
  return {
    readFile: document ? readerFor(document) : undefined,
    allowHtml: config.get<boolean>('allowHtml', true),
    agentBlocks: config.get<'collapsed' | 'expanded' | 'hidden'>('showAgentBlocks', 'collapsed'),
  };
}

function themePreference(frontMatter: Record<string, unknown>): string {
  const setting = vscode.workspace.getConfiguration('smd.preview').get<string>('theme', 'auto');
  if (setting !== 'auto') return setting;
  return frontMatter.theme === 'light' || frontMatter.theme === 'dark' ? String(frontMatter.theme) : 'auto';
}

export interface RenderStatus {
  diagrams: number;
  errors: number;
  math: number;
  tabs: number;
  theme: string;
}

class Preview {
  readonly panel: vscode.WebviewPanel;
  lastStatus: RenderStatus | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastScrollLine = -1;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    column: vscode.ViewColumn,
    onDispose: () => void,
  ) {
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'media'), docDir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    this.panel = vscode.window.createWebviewPanel(
      'smd.preview',
      `Preview ${path.basename(document.fileName)}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, localResourceRoots: roots, enableFindWidget: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'smd-icon.svg');
    this.panel.webview.html = this.shell();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      clearTimeout(this.timer);
      onDispose();
    });
  }

  scheduleUpdate(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), 200);
  }

  update(): void {
    const result = renderSmd(this.document.getText(), renderOptions(this.document));
    this.panel.webview.postMessage({ type: 'update', html: result.html, themePref: themePreference(result.frontMatter) });
  }

  scrollToLine(line: number): void {
    if (line === this.lastScrollLine) return;
    this.lastScrollLine = line;
    this.panel.webview.postMessage({ type: 'scrollToLine', line });
  }

  private shell(): string {
    const webview = this.panel.webview;
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const nonce = randomBytes(16).toString('base64'); // CSP nonces must be unguessable
    const base = webview.asWebviewUri(vscode.Uri.file(path.dirname(this.document.uri.fsPath))).toString().replace(/\/$/, '');
    const result = renderSmd(this.document.getText(), renderOptions(this.document));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en" data-smd-theme-pref="${themePreference(result.frontMatter)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}/">
<link rel="stylesheet" href="${media('vendor', 'katex', 'katex.min.css')}">
<link rel="stylesheet" href="${media('smd.css')}">
</head>
<body class="smd-body">
<main id="smd-root">${result.html}</main>
<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>
<script nonce="${nonce}" src="${media('runtime.js')}"></script>
</body>
</html>`;
  }

  private async onMessage(msg: { type: string; line?: number; href?: string } & Partial<RenderStatus>): Promise<void> {
    switch (msg.type) {
      case 'rendered':
        this.lastStatus = { diagrams: msg.diagrams ?? 0, errors: msg.errors ?? 0, math: msg.math ?? 0, tabs: msg.tabs ?? 0, theme: msg.theme ?? '' };
        break;
      case 'toggleTask':
        if (typeof msg.line === 'number') await toggleTask(this.document, msg.line);
        break;
      case 'revealLine':
        if (typeof msg.line === 'number') await revealLine(this.document, msg.line);
        break;
      case 'openLink':
        if (msg.href) await openLink(this.document, msg.href);
        break;
    }
  }
}

async function toggleTask(document: vscode.TextDocument, line: number): Promise<void> {
  if (line < 0 || line >= document.lineCount) return;
  const text = document.lineAt(line).text;
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(text);
  if (!m) return;
  const edit = new vscode.WorkspaceEdit();
  const pos = new vscode.Position(line, m[1].length);
  edit.replace(document.uri, new vscode.Range(pos, pos.translate(0, 1)), m[2] === ' ' ? 'x' : ' ');
  await vscode.workspace.applyEdit(edit);
}

async function revealLine(document: vscode.TextDocument, line: number): Promise<void> {
  const visible = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const editor = await vscode.window.showTextDocument(document, visible?.viewColumn ?? vscode.ViewColumn.One);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openLink(document: vscode.TextDocument, href: string): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const [file] = href.split('#');
  const target = vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), decodeURIComponent(file)));
  try {
    await vscode.workspace.fs.stat(target);
    await vscode.commands.executeCommand('vscode.open', target, vscode.ViewColumn.One);
  } catch {
    vscode.window.showWarningMessage(`Styled Markdown: "${file}" does not exist.`);
  }
}
