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

/**
 * Updates from the playground arrive over a MessageChannel port it hands this document once, when it loads
 * (main.ts, openPreviewPort), never as window messages, so they can't follow the frame to another page. Each one
 * is passed on to the page runtime as the window message it already handles.
 */
export function isPortHandshake(data: unknown, ports: readonly MessagePort[], fromParent: boolean): boolean {
  return fromParent && ports.length === 1 && (data as { type?: unknown } | null)?.type === 'smd-port';
}

let port: MessagePort | undefined;

/** The playground page's origin, written into the frame by previewDocument. */
const PARENT_ORIGIN = typeof document === 'undefined' ? undefined : document.documentElement.dataset.smdParentOrigin;

function onMessage(event: MessageEvent): void {
  if (event.origin !== PARENT_ORIGIN || event.source !== window.parent) return;
  if (port || !isPortHandshake(event.data, event.ports, true)) return;
  port = event.ports[0];
  port.onmessage = (update) => window.dispatchEvent(new MessageEvent('message', { data: update.data }));
}

if (typeof window !== 'undefined') window.addEventListener('message', onMessage);
