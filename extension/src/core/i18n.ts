import { LOCALES } from './locales';

/**
 * Localized UI labels in rendered HTML: the words the renderer adds around a document's own text (callout titles,
 * "Overdue", "Figure 2", "Footnotes", the site's navigation…). A document picks its language with `lang:` in its
 * front matter, a BCP 47 tag such as `de` or `pt-BR`; renderers may take a fallback language for documents without
 * one. English is the base: a document without `lang`, or in English, renders exactly as it always has.
 *
 * Only the HTML for people is localized. Agent views, `smd to-md` and validator messages stay English: they are
 * read by agents and tools, where stable, compact output matters more.
 */

/** The English labels, which every locale translates. `{name}` is a placeholder filled in by `format`. */
export const EN = {
  // Document header
  'header.owners': 'Owners',
  'header.tags': 'Tags',
  'header.version': 'v{version}',
  'header.updated': 'Updated {date}',
  'header.audience': 'For {audience}',
  'audience.humans': 'humans',
  'audience.agents': 'agents',
  'audience.both': 'both',
  'docStatus.draft': 'draft',
  'docStatus.review': 'review',
  'docStatus.approved': 'approved',
  'docStatus.deprecated': 'deprecated',
  'docStatus.archived': 'archived',
  'toc.title': 'Contents',

  // Callouts and other containers
  'callout.note': 'Note',
  'callout.info': 'Info',
  'callout.tip': 'Tip',
  'callout.success': 'Success',
  'callout.warning': 'Warning',
  'callout.danger': 'Danger',
  'callout.question': 'Question',
  'details.title': 'Details',
  'tab.title': 'Tab',
  'agent.label': 'For agents',
  'human.label': 'For humans',
  'decision.label': 'Decision',
  'decisionStatus.proposed': 'proposed',
  'decisionStatus.accepted': 'accepted',
  'decisionStatus.rejected': 'rejected',
  'decisionStatus.superseded': 'superseded',
  'decisionStatus.deprecated': 'deprecated',
  'risk.title': 'Risk',
  'label.impact': 'Impact',
  'label.likelihood': 'Likelihood',
  'label.owner': 'Owner',
  'impact.low': 'low',
  'impact.medium': 'medium',
  'impact.high': 'high',
  'impact.critical': 'critical',
  'likelihood.low': 'low',
  'likelihood.medium': 'medium',
  'likelihood.high': 'high',
  'likelihood.critical': 'critical',
  'riskStatus.open': 'open',
  'riskStatus.mitigated': 'mitigated',
  'riskStatus.accepted': 'accepted',
  'riskStatus.closed': 'closed',
  'riskMatrix.corner': 'Impact ↓ · Likelihood →',
  'riskMatrix.cell': '{impact} impact, {likelihood} likelihood: {count} risk(s)',
  'include.needsFile': ':::include needs a file, e.g. file="shared/terms.smd"',
  'include.unavailable': 'Include not available here',
  'include.missingFile': 'Cannot read the file',
  'include.missingSection': 'No section "{section}" in the file',
  'include.cycle': 'Include cycle ({chain})',
  'include.thisDocument': 'this document',
  'include.depth': 'Includes nested more than {depth} deep',
  'include.tooLarge': 'Too much included content',
  'figure.figure': 'Figure {n}',
  'figure.table': 'Table {n}',
  'figure.listing': 'Listing {n}',
  'figure.missingRef': 'No figure with this id',
  'quote.caption': '— {by}',
  'quote.separator': ', ',
  'footnote.heading': 'Footnotes',
  'footnote.backref': 'Back to reference {ref}',
  'code.cannotRead': 'Cannot read {file}',

  // Inline directives
  'progress.label': 'Progress',
  'priority.critical': 'critical',
  'priority.high': 'high',
  'priority.medium': 'medium',
  'priority.low': 'low',
  'due.title': 'Due {date}',
  'due.titleOverdue': 'Due {date} (overdue)',
  'due.overdue': 'overdue',
  'due.soon': 'due soon',
  'trend.up': 'up',
  'trend.down': 'down',
  'trend.flat': 'flat',
  'tone.good': 'good',
  'tone.bad': 'bad',
  'statusDot.label': 'status',
  'color.red': 'red',
  'color.orange': 'orange',
  'color.amber': 'amber',
  'color.yellow': 'yellow',
  'color.green': 'green',
  'color.teal': 'teal',
  'color.cyan': 'cyan',
  'color.blue': 'blue',
  'color.indigo': 'indigo',
  'color.purple': 'purple',
  'color.pink': 'pink',
  'color.gray': 'gray',
  'color.muted': 'muted',
  'color.accent': 'accent',

  // Page runtime (copy buttons, diagrams), passed to it in data-smd-labels
  'runtime.copy': 'Copy',
  'runtime.copyCode': 'Copy code',
  'runtime.copied': 'Copied',
  'runtime.codeCopied': 'Code copied',
  'runtime.mermaidMissing': 'Mermaid is not loaded — showing diagram source.',
  'runtime.diagramError': 'Diagram error',

  // Static site (smd build)
  'site.documentation': 'Documentation',
  'site.dashboard': 'Dashboard',
  'site.skip': 'Skip to content',
  'site.menu': 'Menu',
  'site.search': 'Search',
  'site.searchLabel': 'Search the documentation',
  'site.documents': 'Documents',
  'site.linkedFrom': 'Linked from',
  'site.breadcrumb': 'Breadcrumb',
  'site.pager': 'Previous and next',
  'site.previous': 'Previous',
  'site.next': 'Next',
  'site.documentCount': '{count} document(s)',
  'site.searchNoIndex': 'Search is not available: the search index did not load.',
  'site.searchNone': 'No results.',
  'site.searchCount': '{count} result(s)',
  'site.searchUnavailable': 'Search is not available',
  'dashboard.summary': '{tasks} open task(s), {overdue} overdue · {decisions} decision(s), {proposed} proposed · {risks} open risk(s) · {documents} document(s)',
  'dashboard.openTasks': 'Open tasks',
  'dashboard.decisions': 'Decisions',
  'dashboard.openRisks': 'Open risks',
  'dashboard.noTasks': 'No open tasks.',
  'dashboard.noDecisions': 'No decisions.',
  'dashboard.noRisks': 'No open risks.',
  'column.due': 'Due',
  'column.task': 'Task',
  'column.priority': 'Priority',
  'column.where': 'Where',
  'column.date': 'Date',
  'column.status': 'Status',
  'column.score': 'Score',
  'column.mitigation': 'Mitigation',
} as const;

export type MessageKey = keyof typeof EN;

/** A complete set of labels: a locale must translate every key (the compiler checks), and nothing else. */
export type Messages = Readonly<Record<MessageKey, string>>;

/**
 * Groups of words for values written in the document (`status: draft`, `impact=high`, `color=green`…). In
 * English each word is the value itself, so `term` changes nothing there.
 */
export type TermGroup =
  'audience' | 'docStatus' | 'decisionStatus' | 'impact' | 'likelihood' | 'riskStatus' | 'priority' | 'trend' | 'tone' | 'color';

/** The language when a document names none. */
export const DEFAULT_LANG = 'en';

/** Every language with labels, English first. */
export const SUPPORTED_LANGUAGES: readonly string[] = [DEFAULT_LANG, ...Object.keys(LOCALES).sort((a, b) => a.localeCompare(b, 'en'))];

/** A well-formed BCP 47 tag: a 2–3 letter language, then subtags (`pt-BR`, `zh-Hant-TW`). `_` is read as `-`. */
const TAG = /^[a-z]{2,3}(?:-[a-z\d]{1,8})*$/i;

/** The value as a language tag (trimmed, `_` read as `-`), or undefined when it is not one. */
export function languageTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tag = value.trim().replaceAll('_', '-');
  return TAG.test(tag) ? tag : undefined;
}

/**
 * The supported language for a tag, by BCP 47 lookup: the whole tag, then without its last subtag, and so on
 * (`pt-BR` → `pt`, `zh-Hant-TW` → `zh`). Undefined when none matches.
 */
export function matchLanguage(tag: string): string | undefined {
  const parts = (languageTag(tag) ?? '').toLowerCase().split('-');
  for (let n = parts.length; n > 0; n--) {
    const candidate = parts.slice(0, n).join('-');
    if (SUPPORTED_LANGUAGES.includes(candidate)) return candidate;
  }
  return undefined;
}

/** Is this tag English (`en`, `en-GB`…)? English documents render without language attributes, as before. */
export const isEnglish = (tag: string): boolean => tag.toLowerCase().split('-')[0] === DEFAULT_LANG;

/** The language a document renders in: its own `lang` when it is a language tag, else the fallback, else English. */
export function documentLanguage(lang: unknown, fallback?: unknown): string {
  return languageTag(lang) ?? languageTag(fallback) ?? DEFAULT_LANG;
}

const resolved = new Map<string, Messages>();

/** The labels for a language tag. Each label a locale lacks (or leaves empty) is the English one. */
export function messagesFor(tag: string | undefined): Messages {
  const lang = (tag && matchLanguage(tag)) || DEFAULT_LANG;
  let messages = resolved.get(lang);
  if (!messages) {
    messages = completeMessages(lang === DEFAULT_LANG ? undefined : LOCALES[lang]);
    resolved.set(lang, messages);
  }
  return messages;
}

/** A locale with English in place of each label it lacks or leaves empty. */
export function completeMessages(locale: Partial<Messages> | undefined): Messages {
  const out: Record<string, string> = { ...EN };
  for (const [key, text] of Object.entries(locale ?? {})) if (text) out[key] = text;
  return out as Messages;
}

/** Are these the English labels? */
export const isEnglishMessages = (messages: Messages): boolean => messages === messagesFor(DEFAULT_LANG);

/** A label with its `{name}` placeholders filled in; unknown placeholders stay as written. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replaceAll(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The word for a value written in the document, e.g. `term(m, 'docStatus', 'draft')`. A value written in lower
 * case or capitalized gets the word in the same case; any other value (unknown, or `HIGH`) stays as written.
 */
export function term(messages: Messages, group: TermGroup, value: string): string {
  const lower = value.toLowerCase();
  const key = `${group}.${lower}`;
  if (!(key in messages)) return value;
  const word = messages[key as MessageKey];
  if (value === lower) return word;
  return value === capital(lower) ? capital(word) : value;
}

/** A label by key, filled in: `label(m, 'figure.table', { n: 2 })`. */
export function label(messages: Messages, key: MessageKey, values: Record<string, string | number> = {}): string {
  return format(messages[key], values);
}

/** The labels the page runtime (media/runtime.js) reads from `data-smd-labels`, by their key without `runtime.`. */
export function runtimeLabels(messages: Messages): Record<string, string> {
  return prefixed(messages, 'runtime.');
}

/** The labels the site script (media/site.js) reads from `data-smd-labels`: search messages. */
export function siteScriptLabels(messages: Messages): Record<string, string> {
  return prefixed(messages, 'site.search');
}

function prefixed(messages: Messages, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(messages)) {
    if (key.startsWith(prefix) && key !== prefix) out[key.slice(key.indexOf('.') + 1)] = text;
  }
  return out;
}
