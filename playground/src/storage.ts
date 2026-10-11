/**
 * Per-browser conveniences kept in localStorage: the draft and the theme setting. Storage can be missing or throw
 * (private windows, blocked site data, file:// in some browsers), so every access is guarded and the playground
 * works without it.
 */
import type { ThemeSetting } from './frame';

export const DRAFT_KEY = 'smd-playground:draft';
export const THEME_KEY = 'smd-playground:theme';

/** The subset of the Storage interface used here, so tests can pass a stand-in. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readStored(key: string, store: KeyValueStore | undefined = defaultStore()): string | undefined {
  try {
    return store?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** False when the value couldn't be stored. */
export function writeStored(key: string, value: string, store: KeyValueStore | undefined = defaultStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function themeSetting(value: string | undefined): ThemeSetting {
  return value === 'light' || value === 'dark' ? value : 'auto';
}
