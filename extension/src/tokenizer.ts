import * as path from 'node:path';
import type { Tokenizer } from './core';

/**
 * Exact token counts for `--tokenizer`, from the js-tiktoken package when the user has installed it.
 * smd has no runtime dependencies, so the package is never bundled: it is resolved at run time from
 * the working directory (the user's project), next to smd itself, and the global npm folders.
 *
 * These are OpenAI encodings. There is no public tokenizer for current Claude models, so for Claude
 * the counts are approximate too.
 */
export const TOKENIZERS = ['o200k_base', 'cl100k_base', 'p50k_base', 'r50k_base'];

const PACKAGE = 'js-tiktoken';

interface TiktokenModule {
  getEncoding(name: string): { encode(text: string, allowedSpecial?: string[], disallowedSpecial?: string[]): number[] };
}

export class TokenizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenizerError';
  }
}

export interface LoadTokenizerOptions {
  /** Folders to resolve the package from, instead of the working directory, smd's folder and the global folders. */
  paths?: string[];
}

/** Load a tokenizer by encoding name. Throws a TokenizerError with an install hint when the package is missing. */
export function loadTokenizer(name: string, options: LoadTokenizerOptions = {}): Tokenizer {
  if (!TOKENIZERS.includes(name)) {
    throw new TokenizerError(`Unknown tokenizer "${name}". Available: ${TOKENIZERS.join(', ')}.`);
  }
  const lib = requireFrom(options.paths ?? searchPaths());
  if (!lib) {
    throw new TokenizerError(
      `The "${name}" tokenizer needs the ${PACKAGE} package, which smd does not bundle. Install it in your project `
      + `(npm install --save-dev ${PACKAGE}) or globally (npm install -g ${PACKAGE}), then run the command again.`,
    );
  }
  const encoding = lib.getEncoding(name);
  // Special tokens such as <|endoftext|> in a document count as plain text.
  return { name, count: (text) => encoding.encode(text, [], []).length };
}

function requireFrom(paths: string[]): TiktokenModule | undefined {
  let file: string;
  try {
    file = require.resolve(PACKAGE, { paths });
  } catch {
    return undefined;
  }
  // A runtime require of a resolved path, which esbuild leaves alone.
  return require(file) as TiktokenModule;
}

function searchPaths(): string[] {
  return [process.cwd(), __dirname, ...globalFolders()];
}

/** NODE_PATH and the global node_modules folder of npm. */
function globalFolders(): string[] {
  const folders = (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean);
  const prefix = process.env.npm_config_prefix ?? defaultPrefix();
  folders.push(process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'));
  return folders;
}

function defaultPrefix(): string {
  if (process.platform !== 'win32') return path.dirname(path.dirname(process.execPath));
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.dirname(process.execPath);
}
