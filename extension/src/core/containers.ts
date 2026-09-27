import { Attrs, emptyAttrs, findAttrsEnd, parseAttrs } from './attrs';

/** A parsed container opening line: `:::name{attrs} Title text`. */
export interface ContainerInfo {
  name: string;
  attrs: Attrs;
  title: string;
  /** Set when `{...}` is present but malformed. */
  attrsError?: string;
}

export const CONTAINER_OPEN = /^(\s{0,3})(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
export const CONTAINER_CLOSE = /^(\s{0,3})(:{3,})\s*$/;

export function parseContainerInfo(info: string): ContainerInfo | null {
  const m = /^\s*([a-zA-Z][\w-]*)(.*)$/.exec(info);
  if (!m) return null;
  const name = m[1].toLowerCase();
  let rest = m[2];
  let attrs = emptyAttrs();
  let attrsError: string | undefined;
  if (rest.startsWith('{')) {
    const end = findAttrsEnd(rest, 0);
    if (end === -1) {
      attrsError = 'Attribute list is missing its closing "}".';
    } else {
      const parsed = parseAttrs(rest.slice(1, end));
      if (parsed) attrs = parsed; else attrsError = 'Malformed attribute list.';
      rest = rest.slice(end + 1);
    }
  }
  const title = (attrs.values.title ?? rest.trim()) || '';
  return { name, attrs, title, attrsError };
}
