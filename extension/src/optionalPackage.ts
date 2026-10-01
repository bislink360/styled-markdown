import * as path from 'node:path';

/**
 * Optional packages (js-tiktoken for `--tokenizer`, Playwright or Puppeteer for `smd pdf`). smd has no
 * runtime dependencies, so these are never bundled: they are resolved at run time from the working
 * directory (the user's project), next to smd itself, and the global npm folders.
 */
export function requireOptional(name: string, paths: string[] = searchPaths()): unknown {
  let file: string;
  try {
    file = require.resolve(name, { paths });
  } catch {
    return undefined;
  }
  // A runtime require of a resolved path, which esbuild leaves alone.
  return require(file) as unknown;
}

/** Where optional packages are looked for: the working directory, smd's folder and the global folders. */
export function searchPaths(): string[] {
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
