import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderSmd, type RenderOptions } from './core';
import { escapeHtml } from './core/attrs';
import { readerFor } from './files';
import { PreviewSync, readPosition } from './previewSync';
import { openLink, revealLine, toggleTask } from './webviewActions';
import { webviewShell } from './webviewShell';

/** Live preview webviews, one per .smd document. */
export class PreviewManager implements vscode.Disposable {
  private readonly previews = new Map<string, Preview>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.previews.get(e.document.uri.toString())?.scheduleUpdate(e.contentChanges)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const preview = this.previews.get(e.textEditor.document.uri.toString());
        const top = e.visibleRanges[0]?.start.line;
        if (preview && top !== undefined) preview.scrollToLine(top);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('smd.preview')) this.previews.forEach((p) => p.update());
      }),
      // Embedded source files (```ts file="…") or included documents (:::include) may have changed.
      vscode.workspace.onDidSaveTextDocument((d) => {
        const saved = d.uri.toString();
        this.previews.forEach((p, key) => { if (key !== saved) p.scheduleUpdate(); });
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

/** The page's theme: the smd.preview.theme setting, else the document's `theme:`, else the editor's. Also the Block Editor's. */
export function themePreference(frontMatter: Record<string, unknown>): string {
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
  /** Diagrams reused from the SVG cache in this render. */
  reused: number;
  /** Source line anchored at the top of the viewport. */
  top: number;
  /** Number of renders reported so far by this panel. */
  renders: number;
  /** How the page found its place when it loaded: "state", "host", "none", or "waiting" while it has no layout yet. */
  restore?: string;
}

class Preview {
  readonly panel: vscode.WebviewPanel;
  lastStatus: RenderStatus | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastScrollLine = -1;
  private deferredScrollLine: number | undefined;
  /** Line edits and the page's last reported place, so the page keeps its scroll anchor on the same content. */
  private readonly sync: PreviewSync;
  /** Document version the current `webview.html` was rendered from. */
  private htmlVersion: number;

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
    this.htmlVersion = document.version;
    this.sync = new PreviewSync(document.version);
    this.panel.webview.html = this.shell();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    // Hidden webviews are torn down (no retainContextWhenHidden, to save memory) and reload from
    // webview.html when shown again; the page keeps its scroll and UI state with setState(). Nothing here
    // depends on when the page went away or came back: see previewSync.ts.
    this.panel.onDidChangeViewState(() => {
      if (!this.panel.visible) this.update();
    });
    this.panel.onDidDispose(() => {
      clearTimeout(this.timer);
      onDispose();
    });
  }

  scheduleUpdate(changes: readonly vscode.TextDocumentContentChangeEvent[] = []): void {
    this.sync.record(this.document.version, changes.map((c) => ({ startLine: c.range.start.line, endLine: c.range.end.line, text: c.text })));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), 200);
  }

  update(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.panel.visible) {
      // Nothing is listening; refresh the page the webview will reload from.
      this.deferredScrollLine = undefined;
      this.htmlVersion = this.document.version;
      this.panel.webview.html = this.shell();
      return;
    }
    const result = renderSmd(this.document.getText(), renderOptions(this.document));
    // The message is lost if the webview is being torn down or is still loading. The edits stay in `sync`
    // until the page says it has them, and a page that loads from an older `webview.html` asks again ("ready").
    const { version, since, edits } = this.sync.snapshot(this.document.version);
    this.panel.webview.postMessage({ type: 'update', html: result.html, themePref: themePreference(result.frontMatter), version, since, edits });
    if (this.deferredScrollLine !== undefined) {
      const line = this.deferredScrollLine;
      this.deferredScrollLine = undefined;
      this.lastScrollLine = -1;
      this.scrollToLine(line);
    }
  }

  scrollToLine(line: number): void {
    if (line === this.lastScrollLine) return;
    if (this.timer) {
      // The line is in the edited document's numbering; the page still shows the previous render.
      this.deferredScrollLine = line;
      return;
    }
    this.lastScrollLine = line;
    this.panel.webview.postMessage({ type: 'scrollToLine', line });
  }

  private shell(): string {
    const webview = this.panel.webview;
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p)).toString();
    const base = webview.asWebviewUri(vscode.Uri.file(path.dirname(this.document.uri.fsPath))).toString().replace(/\/$/, '');
    const result = renderSmd(this.document.getText(), renderOptions(this.document));
    return webviewShell({
      cspSource: webview.cspSource,
      lang: result.lang ?? 'en',
      htmlAttributes: { 'data-smd-theme-pref': themePreference(result.frontMatter) },
      baseHref: `${base}/`,
      styles: [media('vendor', 'katex', 'katex.min.css'), media('smd.css')],
      bodyClass: 'smd-body',
      body: `<main id="smd-root" data-smd-sync="${escapeHtml(JSON.stringify(this.sync.snapshot(this.document.version)))}">${result.html}</main>`,
      scripts: [media('vendor', 'mermaid.min.js'), media('runtime.js')],
    });
  }

  /** The page saved where it is (after a render, a scroll, or once it could restore its place). */
  private onPosition(msg: object): void {
    const position = readPosition(msg);
    if (!position) return;
    this.sync.confirm(position);
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, top: position.anchor?.line ?? 0 };
  }

  private async onMessage(msg: { type: string; line?: number; href?: string } & Partial<RenderStatus>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // The webview reloaded (e.g. moved to another group) from a page older than the document.
        if (this.htmlVersion !== this.document.version) this.update();
        break;
      case 'rendered':
        this.lastStatus = {
          diagrams: msg.diagrams ?? 0, errors: msg.errors ?? 0, math: msg.math ?? 0, tabs: msg.tabs ?? 0, theme: msg.theme ?? '',
          reused: msg.reused ?? 0, top: msg.top ?? 0, renders: (this.lastStatus?.renders ?? 0) + 1,
          restore: msg.restore,
        };
        break;
      case 'position':
        this.onPosition(msg);
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
