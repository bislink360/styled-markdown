// Mermaid imports DOMPurify, which needs a browser window. Parsing never sanitizes output,
// so in Node the parser only needs these functions to exist.
const purify = {
  isSupported: true,
  addHook(): void {},
  removeHook(): void {},
  removeHooks(): void {},
  removeAllHooks(): void {},
  setConfig(): void {},
  clearConfig(): void {},
  sanitize: (dirty: string): string => dirty,
};
export default purify;
