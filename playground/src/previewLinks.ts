/**
 * Link behaviour inside the sandboxed preview frame (bundled as preview.js and loaded after the page runtime).
 * The frame must never navigate away from the preview: http(s) and mailto links open in a new tab, in-page
 * `#anchors` are left to the runtime, and everything else (relative links to other files, `javascript:` and other
 * schemes) does nothing, since the playground has no files to open.
 */

export type LinkAction = 'anchor' | 'new-tab' | 'block';

export function linkAction(href: string | null): LinkAction {
  const value = (href ?? '').trim();
  if (value.startsWith('#')) return 'anchor';
  if (/^(?:https?|mailto):/i.test(value)) return 'new-tab';
  return 'block';
}

function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  const href = target?.getAttribute('href') ?? target?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (!target || href == null) return;
  const action = linkAction(href);
  // SVG links (in diagrams) can't be given a new-tab target the same way: keep the frame where it is.
  if (action === 'new-tab' && target instanceof HTMLAnchorElement) {
    target.target = '_blank';
    target.rel = 'noopener noreferrer';
  } else if (action !== 'anchor') {
    event.preventDefault();
  }
}

if (typeof document !== 'undefined') document.addEventListener('click', onClick, true);
