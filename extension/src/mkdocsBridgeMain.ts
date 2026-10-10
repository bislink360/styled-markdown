import { MkdocsBridge, serveBridge } from './mkdocsBridge';

// Entry point of the MkDocs plugin's bridge (bundled to dist/mkdocs-bridge.cjs and copied into
// integrations/mkdocs/mkdocs_styled_markdown/bridge.cjs by scripts/build.mjs). See mkdocsBridge.ts.
void serveBridge(new MkdocsBridge(), process.stdin, (line) => process.stdout.write(line));
