import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRuleConfig, type RuleSettings } from './core';

/** Config file names, checked in this order in each folder. */
export const CONFIG_FILES = ['smd.config.json', '.smdrc', '.smdrc.json'];

export interface LoadedConfig {
  /** The config file that applies, if any. */
  file?: string;
  rules: RuleSettings;
  /** Problems in that file (invalid JSON, unknown rules or settings), for the caller to report. */
  problems: string[];
}

/**
 * The rule config for a document: the nearest config file in its folder or a parent folder. The
 * search stops at the repository root (the folder with `.git`) or the filesystem root.
 * `cache` maps folders to results, so a run over many files reads each config once.
 */
export function loadRuleConfig(documentPath: string, cache = new Map<string, LoadedConfig>()): LoadedConfig {
  const visited: string[] = [];
  let result: LoadedConfig = { rules: {}, problems: [] };
  for (let dir = path.dirname(path.resolve(documentPath)); ; dir = path.dirname(dir)) {
    const cached = cache.get(dir);
    if (cached) { result = cached; break; }
    visited.push(dir);
    const file = CONFIG_FILES.map((name) => path.join(dir, name)).find((f) => fs.existsSync(f));
    if (file) { result = readConfigFile(file); break; }
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
  for (const dir of visited) cache.set(dir, result);
  return result;
}

/** Read one config file. */
export function readConfigFile(file: string): LoadedConfig {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, rules: {}, problems: [`Not valid JSON: ${(e as Error).message}`] };
  }
  return { file, ...readRuleConfig(data) };
}
