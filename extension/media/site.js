/* Styled Markdown static site (smd build): collapsible sidebar and client-side search. */
(function () {
  'use strict';

  // ---- Pure helpers (unit-tested in Node via module.exports) ---------------

  const MAX_RESULTS = 20;
  const SNIPPET = 160;

  const WORD_CHAR = /[\p{L}\p{N}]/u;

  /** A word without the punctuation around it: `"refund",` → `refund`. */
  function trimWord(word) {
    let start = 0;
    let end = word.length;
    while (start < end && !WORD_CHAR.test(word[start])) start++;
    while (end > start && !WORD_CHAR.test(word[end - 1])) end--;
    return word.slice(start, end);
  }

  /** Lower-case search words of a query. */
  function terms(query) {
    return String(query || '').toLowerCase().split(/\s+/).map(trimWord).filter(Boolean);
  }

  /** How many of the words occur in the text (lower case), times the weight. */
  function hits(text, words, weight) {
    const lower = String(text || '').toLowerCase();
    return words.filter((w) => lower.includes(w)).length * weight;
  }

  /** Whether every word occurs in one of the texts. */
  function matchesAll(texts, words) {
    const lower = texts.join('\n').toLowerCase();
    return words.every((w) => lower.includes(w));
  }

  /** A page-level result: title, summary and intro. */
  function pageResult(doc, words, order) {
    if (!matchesAll([doc.t, doc.s, doc.x], words)) return null;
    const score = hits(doc.t, words, 8) + hits(doc.s, words, 3) + hits(doc.x, words, 1);
    return { title: doc.t, heading: '', url: doc.u, text: doc.s || doc.x, score, order };
  }

  /** A section result; it must match in its own heading or text, not only through the page title. */
  function sectionResult(doc, section, words, order) {
    if (!matchesAll([doc.t, section.h, section.x], words)) return null;
    const own = hits(section.h, words, 6) + hits(section.x, words, 1);
    if (!own) return null;
    const url = doc.u + (section.a ? '#' + encodeURIComponent(section.a) : '');
    return { title: doc.t, heading: section.h, url, text: section.x, score: own + hits(doc.t, words, 2), order };
  }

  /** Best matches first (then in site order): pages by title, summary and intro, and their sections. */
  function search(index, query, limit) {
    const words = terms(query);
    if (!words.length || !index || !Array.isArray(index.docs)) return [];
    const results = [];
    let order = 0;
    for (const doc of index.docs) {
      results.push(pageResult(doc, words, order++));
      for (const section of doc.h || []) results.push(sectionResult(doc, section, words, order++));
    }
    return results.filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit || MAX_RESULTS);
  }

  /** Up to `max` characters of the text around the first word found. */
  function snippet(text, words, max) {
    const size = max || SNIPPET;
    const source = String(text || '');
    if (source.length <= size) return source;
    const lower = source.toLowerCase();
    const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] || 0;
    const start = Math.max(0, Math.min(at - Math.floor(size / 3), source.length - size));
    return (start > 0 ? '…' : '') + source.slice(start, start + size) + (start + size < source.length ? '…' : '');
  }

  /** The text split into parts, `mark` where a word occurs (case-insensitive), for highlighting with text nodes. */
  function highlightParts(text, words) {
    const source = String(text || '');
    const lower = source.toLowerCase();
    const parts = [];
    let pos = 0;
    while (pos < source.length) {
      const next = nextHit(lower, words, pos);
      if (!next) break;
      if (next.at > pos) parts.push({ text: source.slice(pos, next.at), mark: false });
      parts.push({ text: source.slice(next.at, next.at + next.length), mark: true });
      pos = next.at + next.length;
    }
    if (pos < source.length) parts.push({ text: source.slice(pos), mark: false });
    return parts;
  }

  /** The earliest (then longest) occurrence of any word at or after `from`. */
  function nextHit(lower, words, from) {
    let best = null;
    for (const w of words) {
      const at = lower.indexOf(w, from);
      if (at >= 0 && (!best || at < best.at || (at === best.at && w.length > best.length))) best = { at, length: w.length };
    }
    return best;
  }

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) {
      module.exports = { terms, search, snippet, highlightParts };
    }
    return;
  }

  // ---- Page ----------------------------------------------------------------

  const body = document.body;
  const root = body.getAttribute('data-smd-root') || '';
  document.documentElement.classList.add('smd-site-js');

  // Sidebar: a menu button opens and closes it on narrow screens.
  const menu = document.querySelector('.smd-site-menu');
  const nav = document.getElementById('smd-site-nav');
  function setNav(open) {
    body.classList.toggle('smd-site-nav-open', open);
    if (menu) menu.setAttribute('aria-expanded', String(open));
  }
  if (menu && nav) menu.addEventListener('click', () => setNav(!body.classList.contains('smd-site-nav-open')));

  // Search: the index is a script (so it loads from file:// too), fetched the first time the box is used.
  const input = document.getElementById('smd-site-q');
  const box = document.getElementById('smd-site-results');
  let loading = null;

  function loadIndex() {
    if (window.SMD_SEARCH_INDEX) return Promise.resolve(window.SMD_SEARCH_INDEX);
    if (!loading) {
      loading = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = root + '_smd/search-index.js';
        script.onload = () => resolve(window.SMD_SEARCH_INDEX || null);
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  function textWithMarks(tag, className, text, words) {
    const el = document.createElement(tag);
    el.className = className;
    for (const part of highlightParts(text, words)) {
      if (part.mark) {
        const mark = document.createElement('mark');
        mark.textContent = part.text;
        el.appendChild(mark);
      } else {
        el.appendChild(document.createTextNode(part.text));
      }
    }
    return el;
  }

  function resultLink(result, words) {
    const a = document.createElement('a');
    a.className = 'smd-site-result';
    a.href = root + result.url;
    const title = result.heading ? result.title + ' › ' + result.heading : result.title;
    a.appendChild(textWithMarks('span', 'smd-site-result-title', title, words));
    if (result.text) a.appendChild(textWithMarks('span', 'smd-site-result-text', snippet(result.text, words), words));
    return a;
  }

  function message(text) {
    const p = document.createElement('p');
    p.className = 'smd-site-result-none';
    p.textContent = text;
    return p;
  }

  function showResults(index, query) {
    const words = terms(query);
    box.replaceChildren();
    if (!words.length) {
      box.hidden = true;
      return;
    }
    const results = search(index, query);
    if (!index) box.appendChild(message('Search is not available: the search index did not load.'));
    else if (!results.length) box.appendChild(message('No results.'));
    for (const result of results) box.appendChild(resultLink(result, words));
    box.hidden = false;
  }

  function moveFocus(step) {
    const links = Array.from(box.querySelectorAll('a'));
    if (!links.length) return;
    const current = links.indexOf(document.activeElement);
    const first = step > 0 ? 0 : links.length - 1;
    links[current < 0 ? first : (current + step + links.length) % links.length].focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      box.hidden = true;
      input.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && e.target === input) {
      const first = box.querySelector('a');
      if (first) first.click();
    }
  }

  if (input && box) {
    let timer;
    input.addEventListener('focus', loadIndex, { once: true });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadIndex().then((index) => showResults(index, input.value)), 80);
    });
    input.addEventListener('keydown', onKey);
    box.addEventListener('keydown', onKey);
    document.addEventListener('click', (e) => {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
    // "/" focuses the search box, unless typing somewhere already.
    document.addEventListener('keydown', (e) => {
      const typing = /^(?:INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.classList.contains('smd-site-nav-open')) setNav(false);
  });
})();
