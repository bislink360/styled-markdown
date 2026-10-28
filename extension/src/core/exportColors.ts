import { exportColor } from './exportTree';

/**
 * The colours the exporters that take hex values use (Confluence storage format, Word): smd's named colours as
 * text colours and as background tints. `accent` has no fixed value outside the page theme, so it is left out.
 */
export const TEXT_COLOURS: ReadonlyMap<string, string> = new Map([
  ['red', '#de350b'], ['orange', '#ff8b00'], ['amber', '#ff991f'], ['yellow', '#b38600'], ['green', '#00875a'], ['teal', '#008da6'],
  ['cyan', '#00a3bf'], ['blue', '#0052cc'], ['indigo', '#403294'], ['purple', '#6554c0'], ['pink', '#c2185b'], ['gray', '#6b778c'],
  ['muted', '#6b778c'],
]);

export const BACKGROUNDS: ReadonlyMap<string, string> = new Map([
  ['red', '#ffebe6'], ['orange', '#fff4e5'], ['amber', '#fffae6'], ['yellow', '#fff0b3'], ['green', '#e3fcef'], ['teal', '#e6fcff'],
  ['cyan', '#e6fcff'], ['blue', '#deebff'], ['indigo', '#eae6ff'], ['purple', '#eae6ff'], ['pink', '#ffecf6'], ['gray', '#f4f5f7'],
  ['muted', '#f4f5f7'],
]);

/** A colour as written in the document (`red`, `#0ea5e9`, `rgb(…)`) in CSS, with named colours from `named`; else undefined. */
export function cssColour(value: string | undefined, named: ReadonlyMap<string, string>): string | undefined {
  const c = exportColor(value);
  return c?.named ? named.get(c.named) : c?.css;
}
