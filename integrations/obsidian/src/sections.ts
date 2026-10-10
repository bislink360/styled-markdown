/**
 * Reading view renders a note one section (Markdown block) at a time, and a `:::` container spans several of them:
 * its opening line is in one paragraph, its body in others and its closing `:::` in yet another. These are the rules
 * that map a section to what the plugin shows for it. Pure logic, so it is tested without Obsidian.
 */

/** Lines `start` to `end` of a note, both included and zero-based. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * What to do with one section:
 * - `keep`: no container touches it; Obsidian's rendering stays (inline directives are still added).
 * - `hide`: it is inside a container that an earlier section renders.
 * - `render`: replace it with the engine's rendering of lines `start`–`end`: the containers that start in the section,
 *   in full, and the section's own lines around them.
 */
export type SectionPlan =
  | { kind: 'keep'; partOf?: undefined; owned: LineRange[] }
  | { kind: 'hide'; partOf: LineRange; owned: LineRange[] }
  | { kind: 'render'; start: number; end: number; partOf?: LineRange; owned: LineRange[] };

/**
 * The plan for the section on lines `lineStart`–`lineEnd`, given the note's outermost containers (sorted, disjoint).
 * A container belongs to the section its first line is in; a section that starts inside a container rendered earlier
 * keeps only its lines after that container.
 */
export function planSection(containers: readonly LineRange[], lineStart: number, lineEnd: number): SectionPlan {
  const partOf = containers.find((c) => c.start < lineStart && c.end >= lineStart);
  const start = partOf ? partOf.end + 1 : lineStart;
  if (partOf && start > lineEnd) return { kind: 'hide', partOf, owned: [] };
  let end = lineEnd;
  const owned: LineRange[] = [];
  for (const c of containers) {
    if (c.start >= start && c.start <= end) {
      owned.push(c);
      end = Math.max(end, c.end);
    }
  }
  if (!partOf && !owned.length) return { kind: 'keep', owned };
  return { kind: 'render', start, end, partOf, owned };
}

/**
 * Keeps reading view consistent when Obsidian re-renders only the sections whose text changed. A container is drawn
 * by the section it starts in, so an edit in a later section of it, or one that makes it longer or shorter, leaves
 * a stale drawing behind. The plugin reports each container it draws (`drawn`) or hides a section for (`hidden`);
 * true means the whole view must be rendered again. That is asked for at most once per text of the note, so it can't
 * loop, and not for what the first render of a note will draw anyway (every section is rendered then).
 */
export class RenderSync {
  /** Per note and container start line: the end line and source last drawn. */
  private readonly drawings = new Map<string, string>();
  /** Per note: its text when last seen, and whether that is still the text it was first rendered with. */
  private readonly notes = new Map<string, { text: string; first: boolean }>();
  /** Per note: the text a full render was last asked for. */
  private readonly asked = new Map<string, string>();

  /** A section drew `container` (ending after the section when it spans others). */
  drawn(path: string, text: string, container: LineRange, source: string, sectionEnd: number): boolean {
    const first = this.visit(path, text);
    const key = drawingKey(path, container);
    const before = this.drawings.get(key);
    this.drawings.set(key, drawing(container, source));
    if (first) return false;
    // A container seen for the first time, or with another end, decides how the sections after it render.
    const reshaped = before === undefined ? container.end > sectionEnd : endOf(before) !== container.end;
    return reshaped && this.ask(path, text);
  }

  /** A section inside `container` was hidden (or cut down to its lines after it). */
  hidden(path: string, text: string, container: LineRange, source: string): boolean {
    const first = this.visit(path, text);
    const drawn = this.drawings.get(drawingKey(path, container));
    // On the first render the section that starts the container may simply come later.
    if (drawn === undefined && first) return false;
    return drawn !== drawing(container, source) && this.ask(path, text);
  }

  /** Forget everything (the settings changed, or the plugin unloads). */
  clear(): void {
    this.drawings.clear();
    this.notes.clear();
    this.asked.clear();
  }

  /** Record the note's text; true while it is the text the note was first rendered with. */
  private visit(path: string, text: string): boolean {
    const note = this.notes.get(path);
    if (!note) {
      this.notes.set(path, { text, first: true });
      return true;
    }
    if (note.text !== text) this.notes.set(path, { text, first: false });
    return this.notes.get(path)?.first ?? false;
  }

  private ask(path: string, text: string): boolean {
    if (this.asked.get(path) === text) return false;
    this.asked.set(path, text);
    return true;
  }
}

function drawingKey(path: string, container: LineRange): string {
  return `${path}\u0000${container.start}`;
}

function drawing(container: LineRange, source: string): string {
  return `${container.end}\u0000${source}`;
}

function endOf(drawn: string): number {
  return Number(drawn.slice(0, drawn.indexOf('\u0000')));
}
