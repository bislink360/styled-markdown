// What the preview page needs to come back at the same content after it was reloaded or missed an update.
// No `vscode` import, so the unit tests can drive it.
//
// The page keeps its place as a source line (see "Scroll anchoring" in media/runtime.js). A line number only
// means something for one version of the document, so every saved place carries the document version it was
// measured in, and every line edit the version it produced. Whoever restores a place applies the edits made
// after its version, however old the place is and however often the page was reloaded in between.

/** A line edit and the document version it produced: [version, startLine, endLine, insertedLineBreaks]. */
export type VersionedEdit = [number, number, number, number];

/** Where a page is: the source line at the top of its viewport (null at the very top), in `version`'s line numbers. */
export interface PagePosition {
  anchor: { line: number; offset: number } | null;
  version: number;
}

/** Sent with every render, and embedded in the page a hidden webview reloads from. */
export interface PageSync {
  /** Document version the HTML was rendered from. */
  version: number;
  /** `edits` holds every line edit made after this version; places older than it can't be brought up to date. */
  since: number;
  edits: VersionedEdit[];
  /** The last place the page reported, for a page whose own saved state is older or gone. */
  position?: PagePosition;
}

/** The part of a text change that moves lines. */
export interface LineChange {
  startLine: number;
  endLine: number;
  text: string;
}

export const MAX_EDITS = 500;

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A position message from the page, or undefined when it isn't one. */
export function readPosition(msg: object): PagePosition | undefined {
  const { anchor, version } = msg as { anchor?: unknown; version?: unknown };
  if (!isCount(version)) return undefined;
  if (anchor === null || anchor === undefined) return { anchor: null, version };
  const { line, offset } = anchor as { line?: unknown; offset?: unknown };
  return isCount(line) && isCount(offset) ? { anchor: { line, offset }, version } : undefined;
}

export class PreviewSync {
  private edits: VersionedEdit[] = [];
  private since: number;
  private position: PagePosition | undefined;

  /** `version`: the document version the preview starts from. */
  constructor(version: number) {
    this.since = version;
  }

  /** Remember the line edits of a change that produced document version `version`. */
  record(version: number, changes: readonly LineChange[]): void {
    for (const c of changes) {
      const breaks = c.text.split('\n').length - 1;
      // Edits within one line don't move any line below them.
      if (c.startLine === c.endLine && breaks === 0) continue;
      this.edits.push([version, c.startLine, c.endLine, breaks]);
    }
    if (this.edits.length > MAX_EDITS) {
      // Too many to carry around: older places are restored to their line number as it is.
      this.edits = [];
      this.since = version;
    }
  }

  /**
   * The page saved its place. Edits up to that version are only dropped now: a page that never got them
   * (a message sent to a webview that was being torn down, a reload from an older page) still needs them.
   */
  confirm(position: PagePosition): void {
    this.position = position;
    this.edits = this.edits.filter(([version]) => version > position.version);
    this.since = Math.max(this.since, position.version);
  }

  /** What goes with a page rendered from document version `version`. */
  snapshot(version: number): PageSync {
    return { version, since: this.since, edits: this.edits.slice(), position: this.position };
  }
}
