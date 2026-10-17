import * as fs from 'node:fs';
import { languageTag } from './core/i18n';

/** Small helpers every `smd` command shares: output to -o or stdout, usage errors and options. */

/** Write `content` to `target` (and say so on stderr), or to stdout without one. */
export function write(target: string | undefined, content: string): number {
  if (target) {
    fs.writeFileSync(target, content);
    console.error(`Wrote ${target}`);
  } else {
    process.stdout.write(content);
  }
  return 0;
}

/** A usage error: the message on stderr, exit code 2. */
export function fail(message: string): number {
  console.error(message);
  return 2;
}

/** The file argument, or exit 2 when it is missing or doesn't exist. */
export function requireFile(file: string | undefined): string {
  if (!file || !fs.existsSync(file)) {
    console.error(file ? `Not found: ${file}` : 'Missing file argument.');
    process.exit(2);
  }
  return file;
}

export const LANG_USAGE = '--lang needs a language tag such as de or pt-BR.';

/** The `--lang` value: undefined when not given, null when it is not a language tag. */
export function langOption(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return languageTag(value) ?? null;
}
