import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  imageExtension, imageFolder, imageMarkdown, inCodeBlock, isImagePath, listEnter, mergeLanguageSettings,
  pastedImageBase, uniqueFileName,
} from './editing';

/** Editing ergonomics: list continuation on Enter, image paste and drop, and spell-check setup. */
export function registerEditorFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: 'smd' };
  context.subscriptions.push(
    // A plain command (not a text editor command), so callers can await the edit.
    vscode.commands.registerCommand('smd.onEnterKey', () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? onEnterKey(editor) : vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
    }),
    vscode.languages.registerDocumentDropEditProvider(selector, new ImageDropProvider()),
    vscode.commands.registerCommand('smd.setupSpellCheck', setupSpellCheck),
  );
  // Image paste needs the paste edit API (VS Code 1.97+); older versions still get drop.
  const languages = vscode.languages as Partial<typeof vscode.languages>;
  if (languages.registerDocumentPasteEditProvider && typeof vscode.DocumentPasteEdit === 'function' && vscode.DocumentDropOrPasteEditKind) {
    context.subscriptions.push(languages.registerDocumentPasteEditProvider(selector, new ImagePasteProvider(), {
      providedPasteEditKinds: [ImagePasteProvider.kind],
      pasteMimeTypes: ['image/*'],
    }));
  }
}

// ---------------------------------------------------------------------------
// Enter on list items
// ---------------------------------------------------------------------------

async function onEnterKey(editor: vscode.TextEditor): Promise<void> {
  const { document, selection } = editor;
  const plainEnter = () => vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
  if (!selection.isEmpty || !vscode.workspace.getConfiguration('smd.editor', document.uri).get<boolean>('continueLists', true)) return void plainEnter();
  const line = document.lineAt(selection.active.line);
  const action = listEnter(line.text, selection.active.character);
  if (!action || inCodeBlock(document.getText().split(/\r?\n/), line.lineNumber)) return void plainEnter();
  if (action.kind === 'end') {
    await editor.edit((edit) => edit.replace(line.range, action.line));
    return;
  }
  const escape = (s: string) => s.replace(/[$}\\]/g, '\\$&');
  await editor.insertSnippet(new vscode.SnippetString(`\n${escape(action.prefix)}$0${escape(action.suffix)}`), selection.active);
}

// ---------------------------------------------------------------------------
// Images: drop files, paste from the clipboard
// ---------------------------------------------------------------------------

/** Where images for a document are saved: `smd.images.folder` in its workspace folder. */
function targetFolder(document: vscode.TextDocument): string {
  const folder = vscode.workspace.getConfiguration('smd.images', document.uri).get<string>('folder', 'docs/images');
  return imageFolder(document.uri.fsPath, vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath, folder);
}

async function exists(file: string): Promise<boolean> {
  try { await vscode.workspace.fs.stat(vscode.Uri.file(file)); return true; } catch { return false; }
}

/** A free file name in `folder`, also avoiding names already claimed by this operation. */
async function freeName(folder: string, base: string, ext: string, claimed: Set<string>): Promise<string> {
  const taken = new Set(claimed);
  for (let name = uniqueFileName(base, ext, (n) => taken.has(n)); ; name = uniqueFileName(base, ext, (n) => taken.has(n))) {
    if (!(await exists(path.join(folder, name)))) { claimed.add(name); return name; }
    taken.add(name);
  }
}

const kindOf = (id: string) => (vscode.DocumentDropOrPasteEditKind ? vscode.DocumentDropOrPasteEditKind.Empty.append('smd', id) : undefined);

class ImageDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(document: vscode.TextDocument, _position: vscode.Position, data: vscode.DataTransfer): Promise<vscode.DocumentDropEdit | undefined> {
    if (document.uri.scheme !== 'file') return undefined;
    const uris = ((await data.get('text/uri-list')?.asString()) ?? '')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { try { return vscode.Uri.parse(l); } catch { return undefined; } })
      .filter((u): u is vscode.Uri => !!u && u.scheme === 'file' && isImagePath(u.fsPath));
    if (!uris.length) return undefined;

    // Images already in the workspace are linked where they are; others are copied into the images folder.
    const folder = targetFolder(document);
    const extra = new vscode.WorkspaceEdit();
    const claimed = new Set<string>();
    const links: string[] = [];
    let copied = 0;
    for (const uri of uris) {
      if (vscode.workspace.getWorkspaceFolder(uri)) {
        links.push(imageMarkdown(document.uri.fsPath, uri.fsPath));
        continue;
      }
      const ext = path.extname(uri.fsPath).toLowerCase();
      const name = await freeName(folder, path.basename(uri.fsPath, path.extname(uri.fsPath)), ext, claimed);
      const target = path.join(folder, name);
      extra.createFile(vscode.Uri.file(target), { contents: await vscode.workspace.fs.readFile(uri) });
      links.push(imageMarkdown(document.uri.fsPath, target));
      copied++;
    }
    const edit = new vscode.DocumentDropEdit(links.join('\n\n'));
    edit.title = copied ? `Copy ${copied} image(s) to ${vscode.workspace.asRelativePath(folder)} and link them` : 'Link image(s)';
    const kind = kindOf('image');
    if (kind) edit.kind = kind;
    if (copied) edit.additionalEdit = extra;
    return edit;
  }
}

class ImagePasteProvider implements vscode.DocumentPasteEditProvider {
  static readonly kind = vscode.DocumentDropOrPasteEditKind?.Empty.append('smd', 'image');

  async provideDocumentPasteEdits(document: vscode.TextDocument, _ranges: readonly vscode.Range[], data: vscode.DataTransfer): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (document.uri.scheme !== 'file') return undefined;
    for (const [mime, item] of data) {
      const ext = imageExtension(mime);
      const file = ext ? item.asFile() : undefined;
      if (!ext || !file) continue;
      const folder = targetFolder(document);
      const name = await freeName(folder, pastedImageBase(document.uri.fsPath, new Date()), ext, new Set());
      const target = path.join(folder, name);
      const edit = new vscode.DocumentPasteEdit(imageMarkdown(document.uri.fsPath, target), `Save image to ${vscode.workspace.asRelativePath(target)} and link it`, ImagePasteProvider.kind);
      edit.additionalEdit = new vscode.WorkspaceEdit();
      edit.additionalEdit.createFile(vscode.Uri.file(target), { contents: file });
      return [edit];
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Spell checking
// ---------------------------------------------------------------------------

/**
 * Add .smd patterns to cSpell's `languageSettings` in the workspace (or user) settings, so directive
 * names, attribute lists, mentions, link targets and code aren't flagged. Run on request only: cSpell
 * settings can't be set per language by another extension, and silently changing them would be rude.
 */
async function setupSpellCheck(): Promise<boolean> {
  // cSpell's settings only exist (and can only be written) while its extension is installed.
  if (!vscode.extensions.getExtension('streetsidesoftware.code-spell-checker')) {
    vscode.window.showInformationMessage('Install the Code Spell Checker extension (streetsidesoftware.code-spell-checker), then run this command again.');
    return false;
  }
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const cspell = vscode.workspace.getConfiguration('cSpell');
  await cspell.update('languageSettings', mergeLanguageSettings(cspell.inspect('languageSettings')?.[target === vscode.ConfigurationTarget.Workspace ? 'workspaceValue' : 'globalValue']), target);
  const types = cspell.inspect<Record<string, boolean>>('enabledFileTypes');
  const current = (target === vscode.ConfigurationTarget.Workspace ? types?.workspaceValue : types?.globalValue) ?? {};
  if (current.smd !== true) await cspell.update('enabledFileTypes', { ...current, smd: true }, target);
  vscode.window.showInformationMessage(
    `Spell checking for .smd is set up in ${target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user'} settings (cSpell.languageSettings).`,
  );
  return true;
}
