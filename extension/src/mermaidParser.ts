// Entry for dist/mermaid-parse.js: Mermaid's parser for syntax diagnostics, bundled separately and
// loaded on demand (see mermaidLoader.ts), so the extension and CLI stay small until a document has diagrams.
import mermaid from 'mermaid';

export const parse = (source: string): Promise<unknown> => mermaid.parse(source);
