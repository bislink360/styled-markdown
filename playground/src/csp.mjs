// The playground's Content Security Policy. Plain JavaScript so the build script (which writes it into
// index.html) and the app (frame.ts) share one definition.
//
// An `<iframe srcdoc>` inherits its parent's policy, so this applies inside the sandboxed preview too, where it
// is what stops a document's own scripts: the only scripts that run are files served next to index.html and the
// inline scripts whose SHA-256 hashes are listed (the page runtime, the link handler and Mermaid, which the
// preview inlines because a sandboxed frame can't load files from file://). Never inline `<script>` written in a
// document, `on…=` handlers or `javascript:` URLs. Images are limited to the app's own files and data: URLs, so
// opening a shared link can't call a server the document names (no tracking pixels), and nothing may connect
// anywhere.

/**
 * @param {string[]} scriptHashes base64 SHA-256 hashes of the inline scripts the preview may run
 * @returns {string}
 */
export function appCsp(scriptHashes) {
  return [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`)].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Where the build writes the policy in index.html. */
export const CSP_PLACEHOLDER = '%PLAYGROUND_CSP%';
