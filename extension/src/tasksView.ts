import * as vscode from 'vscode';
import { extractTasks } from './core';
import { taskCheckbox } from './editing';
import {
  groupDescription, groupTasks, isTaskGrouping, overdueCount, taskDescription, withOverdue, UNASSIGNED,
  type FileTask, type TaskGroup, type TaskGrouping,
} from './taskGroups';

/** The SMD Tasks view: open tasks from every .smd file in the workspace, grouped by owner, due date or document. */

const VIEW_ID = 'smd.tasks';
const GROUP_BY_KEY = 'smd.tasks.groupBy';
const SHOW_COMPLETED_KEY = 'smd.tasks.showCompleted';
const HAS_SMD_KEY = 'smd.workspaceHasSmd';
const EXCLUDE = '**/node_modules/**';

type WorkspaceTask = FileTask & { uri: vscode.Uri };
type Group = TaskGroup<WorkspaceTask>;
type Node = { kind: 'group'; group: Group } | { kind: 'task'; task: WorkspaceTask; group: Group };

const GROUPING_LABELS: Record<TaskGrouping, string> = { owner: 'Owner', due: 'Due date', document: 'Document' };

/** Dates in documents are compared with today's UTC date, as in the preview and `smd tasks`. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

const isSmdFile = (uri: vscode.Uri) =>
  uri.scheme === 'file' && uri.path.toLowerCase().endsWith('.smd') && !/\/node_modules\//.test(uri.path) && !!vscode.workspace.getWorkspaceFolder(uri);

/** The document's text: unsaved changes for open documents, the file otherwise. */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Index: tasks per file, kept current
// ---------------------------------------------------------------------------

/** Tasks in every .smd file of the workspace. Scans on first use, then follows edits, saves and file events. */
class TaskIndex implements vscode.Disposable {
  private readonly files = new Map<string, WorkspaceTask[]>();
  private readonly pending = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private scanned: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Fires after files were (re)read, at most every 300 ms while typing. */
  readonly onDidChange = this.emitter.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.smd');
    this.disposables.push(
      watcher,
      this.emitter,
      watcher.onDidCreate((uri) => this.fileAdded(uri)),
      watcher.onDidChange((uri) => this.schedule(uri)),
      watcher.onDidDelete((uri) => this.fileDeleted(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document.uri)),
      // Closing a document drops its unsaved changes: read the file again.
      vscode.workspace.onDidCloseTextDocument((d) => this.schedule(d.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.updateHasSmd();
        if (this.scanned) this.scanned = this.scan();
      }),
    );
  }

  /** Every task, after the first scan. */
  async tasks(): Promise<WorkspaceTask[]> {
    this.scanned ??= this.scan();
    await this.scanned;
    return [...this.files.values()].flat();
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** Read every file again, e.g. for the Refresh button. */
  rescan(): Promise<void> {
    this.scanned = this.scan();
    return this.scanned;
  }

  /** Resolves once pending edits are read (for tests and the Refresh button). */
  async settled(): Promise<void> {
    await this.scanned;
    if (this.pending.size) await this.flush();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*.smd', EXCLUDE);
    this.files.clear();
    await Promise.all(uris.map((uri) => this.read(uri)));
    this.emitter.fire();
  }

  /** Re-read `uri` soon: a burst of keystrokes or file events becomes one refresh. */
  private schedule(uri: vscode.Uri): void {
    if (!this.scanned || !isSmdFile(uri)) return;
    this.pending.add(uri.toString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    const uris = [...this.pending].map((key) => vscode.Uri.parse(key));
    this.pending.clear();
    await Promise.all(uris.map((uri) => this.read(uri)));
    this.emitter.fire();
  }

  private fileAdded(uri: vscode.Uri): void {
    if (isSmdFile(uri)) void vscode.commands.executeCommand('setContext', HAS_SMD_KEY, true);
    this.schedule(uri);
  }

  private fileDeleted(uri: vscode.Uri): void {
    void this.updateHasSmd();
    if (!this.files.delete(uri.toString())) return;
    this.pending.delete(uri.toString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  private async read(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const text = await textOf(uri);
    if (text === undefined) {
      this.files.delete(key);
      return;
    }
    const file = vscode.workspace.asRelativePath(uri);
    this.files.set(key, extractTasks(text).map((t) => ({ ...t, file, uri })));
  }

  /** The view is shown only in workspaces with .smd files. Call once after creating the index. */
  async updateHasSmd(): Promise<void> {
    const found = await vscode.workspace.findFiles('**/*.smd', EXCLUDE, 1);
    await vscode.commands.executeCommand('setContext', HAS_SMD_KEY, found.length > 0);
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

class TasksProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private groups: Group[] = [];
  private built = false;
  /** Open tasks (or all, when completed ones are shown), counted once even when in two groups. */
  shown: WorkspaceTask[] = [];

  constructor(private readonly index: TaskIndex, private readonly state: vscode.Memento) {}

  get groupBy(): TaskGrouping {
    const value = this.state.get(GROUP_BY_KEY);
    return isTaskGrouping(value) ? value : 'due';
  }

  get showCompleted(): boolean {
    return this.state.get(SHOW_COMPLETED_KEY, false);
  }

  /** Rebuild the groups from the index and redraw the tree. */
  async refresh(): Promise<void> {
    await this.rebuild();
    this.emitter.fire(undefined);
  }

  private async rebuild(): Promise<void> {
    const today = todayUtc();
    const all = (await this.index.tasks()).map((t) => withOverdue(t, today));
    this.shown = this.showCompleted ? all : all.filter((t) => !t.done);
    this.groups = groupTasks(this.shown, this.groupBy, today);
    this.built = true;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      if (!this.built) await this.rebuild();
      return this.groups.map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') return node.group.tasks.map((task) => ({ kind: 'task', task, group: node.group }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'group' ? groupItem(node.group, this.groupBy) : taskItem(node.task, node.group);
  }

  /** What the tree shows, for integration tests. */
  snapshot() {
    return {
      groupBy: this.groupBy,
      showCompleted: this.showCompleted,
      overdue: overdueCount(this.shown),
      groups: this.groups.map((g) => ({
        label: g.label,
        description: groupDescription(g.tasks),
        tasks: g.tasks.map((t) => ({ label: t.text, description: taskDescription(t), file: t.uri.fsPath, line: t.line, done: t.done })),
      })),
    };
  }
}

function groupIcon(group: Group, by: TaskGrouping): vscode.ThemeIcon {
  if (by === 'document') return vscode.ThemeIcon.File;
  if (by === 'owner') return new vscode.ThemeIcon(group.label === UNASSIGNED ? 'circle-slash' : 'person');
  return group.key === 'due:overdue' ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground')) : new vscode.ThemeIcon('calendar');
}

function groupItem(group: Group, by: TaskGrouping): vscode.TreeItem {
  const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
  item.id = group.key;
  item.description = groupDescription(group.tasks);
  item.iconPath = groupIcon(group, by);
  if (by === 'document') item.resourceUri = group.tasks[0]?.uri;
  item.contextValue = 'smdTaskGroup';
  return item;
}

function taskItem(task: WorkspaceTask, group: Group): vscode.TreeItem {
  const item = new vscode.TreeItem(task.text || '(empty task)', vscode.TreeItemCollapsibleState.None);
  item.id = `${group.key}|${task.uri.toString()}|${task.line}`;
  item.description = taskDescription(task);
  item.tooltip = taskTooltip(task);
  item.checkboxState = task.done ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  item.command = { command: 'smd.openTask', title: 'Open Task', arguments: [task.uri, task.line] };
  item.contextValue = 'smdTask';
  return item;
}

/** The task, its section and where it is: `docs/plan.smd:12`. */
function taskTooltip(task: WorkspaceTask): string {
  const where = `${task.file}:${task.line + 1}`;
  const lines = [task.text, taskDescription(task), task.section ? `Section: ${task.section}` : '', where];
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Editing tasks
// ---------------------------------------------------------------------------

/** The task's line now: where it was, or where a task with the same text moved to. */
function currentLine(document: vscode.TextDocument, task: WorkspaceTask): number | undefined {
  const tasks = extractTasks(document.getText());
  const same = tasks.find((t) => t.line === task.line && t.text === task.text) ?? tasks.find((t) => t.text === task.text);
  return same?.line;
}

/** Check or uncheck a task in its file. A file without unsaved changes is saved, so the change isn't left pending in the background. */
async function setTaskDone(task: WorkspaceTask, done: boolean): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(task.uri);
  const line = currentLine(document, task);
  const box = line === undefined ? undefined : taskCheckbox(document.lineAt(line).text);
  if (line === undefined || !box) {
    vscode.window.showWarningMessage(`Styled Markdown: "${task.text}" is no longer in ${task.file}.`);
    return false;
  }
  if (box.done === done) return true;
  const wasDirty = document.isDirty;
  const edit = new vscode.WorkspaceEdit();
  const pos = new vscode.Position(line, box.column);
  edit.replace(task.uri, new vscode.Range(pos, pos.translate(0, 1)), done ? 'x' : ' ');
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied && !wasDirty) await document.save();
  return applied;
}

async function openTask(uri: vscode.Uri, line: number): Promise<void> {
  const pos = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: true });
}

async function pickGrouping(current: TaskGrouping): Promise<TaskGrouping | undefined> {
  const items = (Object.keys(GROUPING_LABELS) as TaskGrouping[]).map((by) => ({
    label: GROUPING_LABELS[by],
    description: by === current ? 'current' : '',
    by,
  }));
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Group tasks by' }))?.by;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTasksView(context: vscode.ExtensionContext): void {
  const index = new TaskIndex();
  void index.updateHasSmd();
  const provider = new TasksProvider(index, context.workspaceState);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, manageCheckboxStateManually: true, showCollapseAll: true });

  const redraw = async () => {
    await provider.refresh();
    updateView(view, provider, index.fileCount);
  };
  const setOption = async (key: string, value: unknown) => {
    await context.workspaceState.update(key, value);
    await vscode.commands.executeCommand('setContext', key, value);
    await redraw();
  };
  void vscode.commands.executeCommand('setContext', GROUP_BY_KEY, provider.groupBy);
  void vscode.commands.executeCommand('setContext', SHOW_COMPLETED_KEY, provider.showCompleted);

  context.subscriptions.push(
    index,
    view,
    index.onDidChange(redraw),
    view.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        if (node.kind === 'task') await setTaskDone(node.task, state === vscode.TreeItemCheckboxState.Checked);
      }
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void redraw();
    }),
    vscode.commands.registerCommand('smd.openTask', openTask),
    vscode.commands.registerCommand('smd.groupTasksBy', async (by?: unknown) => {
      const next = isTaskGrouping(by) ? by : await pickGrouping(provider.groupBy);
      if (next) await setOption(GROUP_BY_KEY, next);
    }),
    vscode.commands.registerCommand('smd.showCompletedTasks', () => setOption(SHOW_COMPLETED_KEY, true)),
    vscode.commands.registerCommand('smd.hideCompletedTasks', () => setOption(SHOW_COMPLETED_KEY, false)),
    vscode.commands.registerCommand('smd.refreshTasks', async () => {
      await index.rescan();
      await redraw();
    }),

    // Internal (not in the command palette): let integration tests read the tree and use its checkboxes.
    vscode.commands.registerCommand('smd._tasksTree', async () => {
      await index.settled();
      await redraw();
      return provider.snapshot();
    }),
    vscode.commands.registerCommand('smd._checkTask', async (file: string, line: number, done: boolean) => {
      const task = provider.shown.find((t) => t.uri.fsPath === file && t.line === line);
      return task ? setTaskDone(task, done) : false;
    }),
  );
}

/** The grouping as the view's description, the overdue count as its badge, and a message when it's empty. */
function updateView(view: vscode.TreeView<Node>, provider: TasksProvider, files: number): void {
  const overdue = overdueCount(provider.shown);
  view.description = `by ${GROUPING_LABELS[provider.groupBy].toLowerCase()}`;
  view.badge = overdue ? { value: overdue, tooltip: `${overdue} overdue task(s)` } : undefined;
  view.message = emptyMessage(provider, files);
}

function emptyMessage(provider: TasksProvider, files: number): string | undefined {
  if (provider.shown.length) return undefined;
  if (!files) return 'No .smd files in this workspace.';
  return provider.showCompleted ? 'No tasks in .smd files.' : 'No open tasks in .smd files.';
}
