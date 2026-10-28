import * as path from 'node:path';
import {
  notionRequests, renderPage, smdToConfluence, smdToMarkdown, smdToNotion, suggest, type ExportOptions,
} from './core';
import { smdToPandocHtml } from './core/pandoc';
import { SUPPORTED_LANGUAGES } from './core/i18n';
import { exportPdf, loadPdfEngine, PdfError, pdfOptions, pdfPath } from './pdf';
import { DocxError, docxPath, exportDocx, findPandoc } from './docx';
import { read, readerFor } from './workspace';
import { fail, langOption, LANG_USAGE, requireFile, write } from './cliIo';

/**
 * `smd export <file> --to <format>`: every single-document export of the CLI behind one command. The older
 * commands (`smd render`, `smd to-md`, `smd pdf`, `smd docx`) stay as aliases that run the same code, so
 * their output, exit codes and options don't change. Commands that read many documents and write a report
 * or a folder (`smd build`, `smd tasks --csv`, `smd risks --html`, `smd decisions --md`) are not exports.
 */

/** The parsed command line, as cli.ts's parseArgs makes it. */
export interface ExportArgs { positional: string[]; flags: Set<string>; values: Map<string, string[]> }

type Run = (args: ExportArgs) => number | Promise<number>;

interface ExportFormat {
  name: string;
  /** The -o extension that picks this format when --to is missing. */
  extension?: string;
  run: Run;
}

const option = (args: ExportArgs, name: string) => args.values.get(name)?.[0];

/** `--to html`, `smd render`: the standalone page. */
function html(args: ExportArgs): number {
  const file = requireFile(args.positional[0]);
  const lang = langOption(option(args, '--lang'));
  if (lang === null) return fail(LANG_USAGE);
  return write(option(args, '-o'), renderPage(read(file), { readFile: readerFor(file), lang }));
}

/** `--to md`, `smd to-md`: plain GitHub-flavored Markdown. */
function markdown(args: ExportArgs): number {
  return write(option(args, '-o'), smdToMarkdown(read(requireFile(args.positional[0])), { readFile: readerFor(args.positional[0]) }));
}

/** `--to pdf`, `smd pdf`: render the page and print it with a headless browser (pdf.ts); exit 2 when there is none. */
async function pdf(args: ExportArgs): Promise<number> {
  const file = requireFile(args.positional[0]);
  try {
    const options = pdfOptions(option(args, '--format'), args.flags.has('--landscape'));
    const engine = loadPdfEngine({ browser: option(args, '--browser') });
    const out = option(args, '-o') ?? pdfPath(file);
    const lang = langOption(option(args, '--lang'));
    if (lang === null) return fail(LANG_USAGE);
    const page = renderPage(read(file), { readFile: readerFor(file), lang });
    await exportPdf(file, page, out, options, { engine, warn: (message) => console.error(message) });
    console.error(`Wrote ${out} (printed with ${engine.name})`);
    return 0;
  } catch (err) {
    if (err instanceof PdfError) return fail(err.message);
    console.error(`Printing failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** `--to docx`, `smd docx`: the Pandoc profile of the document, converted by Pandoc; exit 2 when Pandoc is missing. */
async function docx(args: ExportArgs): Promise<number> {
  const file = requireFile(args.positional[0]);
  const lang = langOption(option(args, '--lang'));
  if (lang === null) return fail(LANG_USAGE);
  const page = smdToPandocHtml(read(file), { readFile: readerFor(file), lang });
  if (args.flags.has('--html-only')) return write(option(args, '-o'), page);
  const out = option(args, '-o') ?? docxPath(file);
  try {
    const pandoc = findPandoc({ explicit: option(args, '--pandoc') });
    const warnings = await exportDocx(pandoc, page, { out, resourcePath: path.dirname(path.resolve(file)), referenceDoc: option(args, '--reference-doc') });
    if (warnings) console.error(warnings);
    console.error(`Wrote ${out} (converted with ${pandoc})`);
    return 0;
  } catch (err) {
    if (err instanceof DocxError) return fail(err.message);
    console.error(`Converting to .docx failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** `--to confluence|notion`: a page in a wiki's own format, to -o or stdout. */
function wiki(exporter: (text: string, options: ExportOptions) => string): Run {
  return (args) => {
    const lang = langOption(option(args, '--lang'));
    if (lang === null) return fail(LANG_USAGE);
    const source = requireFile(args.positional[0]);
    return write(option(args, '-o'), exporter(read(source), { readFile: readerFor(source), lang }));
  };
}

const FORMATS: readonly ExportFormat[] = [
  { name: 'html', extension: '.html', run: html },
  { name: 'md', extension: '.md', run: markdown },
  { name: 'pdf', extension: '.pdf', run: pdf },
  { name: 'docx', extension: '.docx', run: docx },
  { name: 'confluence', run: wiki(smdToConfluence) },
  { name: 'notion', run: wiki((text, options) => `${JSON.stringify(notionRequests(smdToNotion(text, options)), null, 2)}\n`) },
];

/** The formats of `smd export --to`, in the order the help lists them. */
export const EXPORT_FORMATS = FORMATS.map((f) => f.name);

/** The older command names, each the export of one format. */
export const EXPORT_ALIASES: ReadonlyMap<string, string> = new Map([['render', 'html'], ['to-md', 'md'], ['pdf', 'pdf'], ['docx', 'docx']]);

const INFERRED = FORMATS.filter((f) => f.extension).map((f) => f.extension).join(', ');

export const EXPORT_USAGE = `Usage: smd export <file.smd> --to ${EXPORT_FORMATS.join('|')} [-o <file>] [options]\n`
  + `Without --to, the extension of -o picks the format (${INFERRED}). smd export --help lists the options.`;

/** The `smd export` part of `smd --help`. */
export const EXPORT_HELP = `  smd export <file.smd> --to <format> [-o <file>] [--lang <tag>] [format options]
      The document in another format, written to -o, else printed (pdf and docx: next to the file).
      Without --to, the extension of -o picks the format: ${INFERRED}.
      --lang      language of the labels it adds ("Note", "Figure 2", "overdue"…) when the document has
                  no "lang:" of its own, e.g. de or pt-BR (${SUPPORTED_LANGUAGES.join(', ')}; others are English).
                  Every format but md, which stays English.
      html        Standalone HTML page (prints well: it has a print stylesheet)
      md          Plain GitHub-flavored Markdown (callouts → GitHub alerts)
      pdf         [--format A4|Letter] [--landscape] [--browser <path>]
                  PDF of the rendered page, with diagrams as vectors, printed by a headless browser; smd
                  doesn't bundle one. It uses --browser (or the SMD_BROWSER environment variable), else
                  Playwright or Puppeteer from your project or global folder, else an installed Google
                  Chrome, Microsoft Edge, Chromium or Brave. Without any, use
                  smd export <file.smd> --to html -o page.html and the browser's Print → Save as PDF.
                  --browser  a Chromium-based browser's executable (Chrome, Edge, Chromium, Brave)
      docx        [--pandoc <path>] [--reference-doc <file.docx>] [--html-only]
                  Word document, converted by Pandoc 3, which smd doesn't bundle: it is found at --pandoc,
                  the SMD_PANDOC environment variable or on the PATH (https://pandoc.org/installing.html).
                  Headings, tables, figure captions, footnotes and math become Word's own; callouts and
                  decisions are quotes under a bold title, tabs and details are expanded, Mermaid diagrams
                  keep their source.
                  --reference-doc  a .docx whose styles to use (fonts, headings, captions, quotes)
                  --html-only      write the HTML smd hands Pandoc instead (to -o or stdout), to run Pandoc
                                   yourself: pandoc page.html -f html -t docx -o page.docx, in the
                                   document's folder (for images)
      confluence  Confluence storage format (body.storage in the REST API, or Insert markup), built-in
                  macros only: callouts → info/note/tip/warning, code → code, :::details, tabs and agent
                  blocks → expand, tasks → task lists, badges and statuses → status, :due → dates.
                  Images by URL; relative ones as page attachments of the same name (upload them too).
                  Raw HTML is reduced to its text. No network, no credentials: smd only writes the page.
      notion      Notion API blocks as a JSON array of request bodies for PATCH /v1/blocks/{id}/children,
                  to send in order (each at most 100 top-level and 1000 blocks). Text is split at 2000
                  characters and nesting past two levels flattened; links within the page become text.
      Older names, which still work with the same options and output: smd render (--to html),
      smd to-md (--to md), smd pdf (--to pdf) and smd docx (--to docx).`;

/** The chosen format, or why there is none (a usage error). */
export type FormatChoice = { format: string } | { problem: string };

/** The format --to names (in any case), else the one -o's extension implies. --to wins over -o. */
export function exportFormat(args: ExportArgs): FormatChoice {
  const to = option(args, '--to');
  if (to === '') return { problem: `--to needs a format.\n${EXPORT_USAGE}` };
  if (to !== undefined) {
    const name = to.toLowerCase();
    if (EXPORT_FORMATS.includes(name)) return { format: name };
    const hint = suggest(name, EXPORT_FORMATS);
    const didYouMean = hint ? ` Did you mean "${hint}"?` : '';
    return { problem: `Unknown export format "${to}".${didYouMean}\n${EXPORT_USAGE}` };
  }
  const out = option(args, '-o');
  if (out === undefined) return { problem: `smd export needs --to <format>.\n${EXPORT_USAGE}` };
  const inferred = inferExportFormat(out);
  if (inferred) return { format: inferred };
  return { problem: `Cannot tell the format from "${out}": give --to <format>.\n${EXPORT_USAGE}` };
}

/** The format an output file's extension implies (.html, .md, .pdf or .docx, in any case), if any. */
export function inferExportFormat(out: string): string | undefined {
  const extension = path.extname(out).toLowerCase();
  return FORMATS.find((f) => f.extension === extension)?.name;
}

/** `smd export …` and its older names (`render`, `to-md`, `pdf`, `docx`). */
export function runExport(command: string, args: ExportArgs): number | Promise<number> {
  const alias = EXPORT_ALIASES.get(command);
  if (alias !== undefined) return formatNamed(alias).run(args);
  if (args.flags.has('--help') || args.flags.has('-h')) {
    process.stdout.write(`${EXPORT_USAGE}\n\n${EXPORT_HELP}\n`);
    return 0;
  }
  const choice = exportFormat(args);
  if ('problem' in choice) return fail(choice.problem);
  return formatNamed(choice.format).run(args);
}

function formatNamed(name: string): ExportFormat {
  const format = FORMATS.find((f) => f.name === name);
  if (!format) throw new Error(`No export format "${name}".`);
  return format;
}
