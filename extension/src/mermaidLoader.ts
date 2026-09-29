import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MermaidParse } from './core/mermaid';

let parser: MermaidParse | null | undefined;

/**
 * Mermaid's parser from dist/mermaid-parse.js next to this bundle, loaded on first use. Returns
 * undefined where it isn't shipped (e.g. the single-file CLI inside the agent skills). Calls are
 * queued, because Mermaid keeps per-diagram state while it parses.
 */
export function loadMermaidParser(): MermaidParse | undefined {
  if (parser === undefined) {
    parser = null;
    const file = path.join(__dirname, 'mermaid-parse.js');
    if (fs.existsSync(file)) {
      try {
        // A runtime require of a file beside the bundle, which esbuild leaves alone.
        const { parse } = require(file) as { parse: MermaidParse };
        let queue: Promise<unknown> = Promise.resolve();
        parser = (source) => {
          const run = queue.then(() => parse(source));
          queue = run.catch(() => undefined);
          return run;
        };
      } catch {
        parser = null;
      }
    }
  }
  return parser ?? undefined;
}
