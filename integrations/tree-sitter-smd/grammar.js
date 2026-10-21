/**
 * @file Tree-sitter grammar for Styled Markdown (.smd): the syntax .smd adds to Markdown.
 * @author Roshan Alwis
 * @license MIT
 *
 * This grammar is the host language of a .smd buffer. It parses only what Styled Markdown adds
 * (docs/SPEC.md): front matter, `:::name{attrs} Title` … `:::` containers, fenced code and `$$` math
 * (so that their contents are opaque), and inline directives, styled spans, `==mark==`, `$math$`,
 * `{{variables}}`, footnotes, task boxes and attribute lists. Everything else is a `line`, and
 * queries/injections.scm hands those lines to tree-sitter-markdown as one combined document, so
 * Markdown itself is highlighted by the Markdown grammars, not re-implemented here.
 *
 * Constructs that need lookahead to tell them from plain text (an opener that is only syntax when a
 * matching closer follows on the same line) are recognized by src/scanner.c, which mirrors the
 * rules of extension/src/core/markdownItRules.ts. Any text that is not valid .smd syntax parses as
 * plain text, so a document never gets ERROR nodes from unfinished constructs.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: 'smd',

  // Whitespace is significant (it separates lines and blocks), so nothing is skipped implicitly.
  extras: () => [],

  externals: ($) => [
    $._container_fence,
    $._container_end,
    $._code_fence_open,
    $.code_content,
    $._code_fence_close,
    $._math_block_open,
    $._math_block_content,
    $._math_block_close,
    $._front_matter_open,
    $._front_matter_content,
    $._front_matter_close,
    $._attr_open,
    $._trailing_attr_open,
    $._directive_marker,
    $.directive_content,
    $._span_open,
    $.span_content,
    $._mark_open,
    $.mark_content,
    $._math_open,
    $._inline_math_content,
    $._variable_open,
    $._eof,
    $._error_sentinel,
  ],

  rules: {
    document: ($) => seq(
      optional($.front_matter),
      // A `:::` with no open container is kept as a (stray) close rather than an error.
      repeat(choice($._block, $.container_close)),
    ),

    _block: ($) => choice(
      $.container,
      $.fenced_code_block,
      $.math_block,
      $.blank_line,
      $.line,
    ),

    _eol: ($) => choice($._newline, $._eof),
    _newline: () => token(prec(1, /\r?\n/)),
    _ws: () => /[ \t\r]+/,

    // ---------------------------------------------------------------- front matter (spec §2.1)

    front_matter: ($) => seq(
      alias($._front_matter_open, $.front_matter_delimiter),
      $._newline,
      optional(alias($._front_matter_content, $.front_matter_content)),
      alias($._front_matter_close, $.front_matter_delimiter),
      $._eol,
    ),

    // ---------------------------------------------------------------- containers (spec §3)

    // Spec v1: a bare `:::` closes the innermost open container; colon counts are cosmetic. Spec v2
    // (`smd: 2`): it closes the innermost container opened with as many colons, and the scanner ends
    // the ones inside it first with an empty _container_end. An unclosed container runs to the end
    // of its parent.
    container: ($) => prec.right(seq(
      field('open', $.container_open),
      repeat($._block),
      optional(choice(field('close', $.container_close), $._container_end)),
    )),

    container_open: ($) => seq(
      alias($._container_fence, $.container_fence),
      field('name', $.container_name),
      optional(field('attributes', $.attribute_list)),
      optional($._ws),
      optional(field('title', $.container_title)),
      $._eol,
    ),

    container_close: ($) => seq(alias($._container_fence, $.container_fence), $._eol),

    // Any name parses, known or not (unknown names render as a plain box), so highlighting keeps
    // working for new or misspelled names. queries/highlights.scm marks the known ones.
    container_name: () => /[A-Za-z][A-Za-z0-9_-]*/,
    container_title: () => /[^ \t\r\n][^\r\n]*/,

    // ---------------------------------------------------------------- fenced code (spec §6)

    fenced_code_block: ($) => seq(
      alias($._code_fence_open, $.code_fence_delimiter),
      optional($._info_ws),
      optional($.info_string),
      $._eol,
      optional($.code_content),
      optional(seq(alias($._code_fence_close, $.code_fence_delimiter), $._eol)),
    ),

    info_string: ($) => choice(seq($.language, optional($._info_rest)), $._info_rest),
    language: () => token(prec(2, /[^ \t\r\n`{]+/)),
    _info_ws: () => token(prec(1, /[ \t]+/)),
    _info_rest: () => /[^\r\n]+/,

    // ---------------------------------------------------------------- display math (spec §4.4)

    math_block: ($) => seq(
      alias($._math_block_open, $.math_delimiter),
      optional(alias($._math_block_content, $.math_content)),
      alias($._math_block_close, $.math_delimiter),
      $._eol,
    ),

    // ---------------------------------------------------------------- lines

    blank_line: () => /[ \t]*\r?\n/,

    line: ($) => seq(
      choice(seq($._line_start, repeat($._inline)), repeat1($._inline)),
      $._eol,
    ),

    _line_start: ($) => choice(
      seq($._list_marker, optional(choice($.task_checked, $.task_unchecked))),
      $.footnote_label,
    ),

    _list_marker: () => /[ \t]*([-*+]|[0-9]{1,9}[.)])[ \t]+/,
    // GFM task boxes (spec §4.5): the box and the blank after it.
    task_checked: () => /\[[xX]\][ \t]/,
    task_unchecked: () => /\[ \][ \t]/,
    // `[^label]:` starting a footnote definition (spec §4.6).
    footnote_label: () => /[ \t]{0,3}\[\^[^\] \t\r\n]+\]:/,

    // ---------------------------------------------------------------- inline (spec §4)

    _inline: ($) => choice(
      $._word,
      $._colons,
      $._punctuation,
      $._ws,
      $._escape,
      $.code_span,
      $.directive,
      $.span,
      $.mark,
      $.inline_math,
      $.variable,
      $.footnote_reference,
      alias($._trailing_attribute_list, $.attribute_list),
    ),

    // Plain text. A word keeps the colons inside and after it, so `10:30` and `note:[x]` are never
    // directives: a directive's `:` comes after whitespace, opening punctuation or the line start.
    _word: () => /[^ \t\r\n:\[{=$`\\(>*_~"'\-][^ \t\r\n\[{=$`\\(>*_~"'\-]*/,
    _colons: () => /:+/,
    _punctuation: () => /[\[{=$`\\(>*_~"'\-]/,
    _escape: () => /\\[^\r\n]/,

    // Code spans are opaque, so .smd syntax inside them is not highlighted.
    code_span: () => token(choice(/`[^`\r\n]+`/, /``([^`\r\n]|`[^`\r\n])+``/)),

    // `:name[content]{attrs}` (spec §4.2). The scanner only starts one when the brackets and the
    // attribute list are complete, and with a lower-case name in spec v1 (any case in spec v2).
    directive: ($) => seq(
      alias($._directive_marker, ':'),
      field('name', $.directive_name),
      optional(seq('[', optional(field('content', $.directive_content)), ']')),
      optional(field('attributes', $.attribute_list)),
    ),
    directive_name: () => /[A-Za-z][A-Za-z0-9-]*/,

    // `[text]{attrs}` (spec §4.1).
    span: ($) => seq(
      alias($._span_open, '['),
      optional(field('content', $.span_content)),
      ']',
      field('attributes', $.attribute_list),
    ),

    // `==text==` (spec §4.3).
    mark: ($) => seq(alias($._mark_open, '=='), field('content', $.mark_content), '=='),

    // `$x^2$` (spec §4.4).
    inline_math: ($) => seq(
      alias($._math_open, '$'),
      field('content', alias($._inline_math_content, $.math_content)),
      '$',
    ),

    // `{{name}}` (spec §4.7).
    variable: ($) => seq(
      alias($._variable_open, '{{'),
      optional($._ws),
      field('name', $.variable_name),
      optional($._ws),
      '}}',
    ),
    variable_name: () => /[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*/,

    footnote_reference: () => /\[\^[^\] \t\r\n]+\]/,

    // ---------------------------------------------------------------- attribute lists (spec §5)

    // Directly after a container name, a directive or a span.
    attribute_list: ($) => seq(alias($._attr_open, '{'), $._attribute_body),
    // Anywhere else only at the end of a line: `## Heading {#id}` (spec §4.2.2).
    _trailing_attribute_list: ($) => seq(alias($._trailing_attr_open, '{'), $._attribute_body),

    _attribute_body: ($) => seq(repeat($._attribute_item), '}'),
    _attribute_item: ($) => choice(
      $._ws,
      $.attribute,
      $.attribute_id,
      $.attribute_class,
      $._attribute_text,
    ),

    attribute: ($) => prec.right(seq(
      field('name', $.attribute_name),
      optional(seq('=', optional(field('value', $.attribute_value)))),
    )),
    attribute_name: () => /[A-Za-z_][A-Za-z0-9_-]*/,
    attribute_value: ($) => choice($._quoted, token(prec(1, /[^ \t\r\n"'}]+/))),
    attribute_id: () => /#[^ \t\r\n"'}]*/,
    attribute_class: () => /\.[^ \t\r\n"'}]*/,
    _quoted: () => token(choice(/"[^"\r\n]*"/, /'[^'\r\n]*'/)),
    // Anything else inside the braces (the validator reports it; here it is just text).
    _attribute_text: ($) => choice($._quoted, '=', /[^ \t\r\nA-Za-z_#."'}=][^ \t\r\n"'}=]*/),
  },
});
