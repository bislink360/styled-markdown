import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Reader for ```lang file="…"``` embeds. Only files inside an open workspace folder or the
 * document's own folder can be read, so an untrusted .smd cannot pull in e.g. ~/.ssh keys.
 */
export function readerFor(document: vscode.TextDocument): ((rel: string) => string | undefined) | undefined {
  if (document.uri.scheme !== 'file') return undefined;
  const dir = path.dirname(document.uri.fsPath);
  const roots = [dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].map((r) => path.resolve(r));
  return (rel: string) => {
    const target = path.resolve(dir, rel);
    if (!roots.some((r) => target === r || target.startsWith(r + path.sep))) return undefined;
    try {
      return fs.readFileSync(target, 'utf8');
    } catch {
      return undefined;
    }
  };
}
