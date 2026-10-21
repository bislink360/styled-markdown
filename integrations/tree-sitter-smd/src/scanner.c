/*
 * External scanner for tree-sitter-smd.
 *
 * Styled Markdown syntax is only syntax when it is complete: `[text]{attrs}` needs its `]` and
 * `{…}`, `==mark==` and `$math$` need their closers, `$$` math and front matter need a closing line.
 * Tree-sitter's own lexer cannot look ahead, so this scanner checks the whole construct before it
 * returns the opener, and otherwise declines so the text parses as plain text. The rules mirror
 * extension/src/core/markdownItRules.ts (inline constructs stay on one line here).
 *
 * It also scans the bodies of fenced code, `$$` math and front matter as single tokens, so that
 * nothing inside them is parsed as .smd and they can be injected as one range.
 *
 * The front matter decides the rules (docs/SPEC.md §10): `smd: 2` (or a higher whole number) reads
 * the document with the spec v2 rules, anything else with the v1 rules. The v2 rules here: a closing
 * fence closes the innermost container opened with as many colons; `$$` math opens and closes only on
 * lines that are just `$$`; directive names in any case; and a heading's trailing `{}` or `{word}` is
 * text. To pair fences, the scanner keeps the colon counts of the open containers.
 */

#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>

enum TokenType {
  CONTAINER_FENCE,
  CONTAINER_END,
  CODE_FENCE_OPEN,
  CODE_CONTENT,
  CODE_FENCE_CLOSE,
  MATH_BLOCK_OPEN,
  MATH_BLOCK_CONTENT,
  MATH_BLOCK_CLOSE,
  FRONT_MATTER_OPEN,
  FRONT_MATTER_CONTENT,
  FRONT_MATTER_CLOSE,
  ATTR_OPEN,
  TRAILING_ATTR_OPEN,
  DIRECTIVE_MARKER,
  DIRECTIVE_CONTENT,
  SPAN_OPEN,
  SPAN_CONTENT,
  MARK_OPEN,
  MARK_CONTENT,
  MATH_OPEN,
  MATH_CONTENT,
  VARIABLE_OPEN,
  EOF_TOKEN,
  ERROR_SENTINEL,
};

/* Open containers whose colon counts are kept; deeper ones pair like spec v1 (the innermost). */
#define MAX_CONTAINERS 250

typedef struct {
  /* The open code fence: its character (` or ~) and length, so the right line closes it. */
  uint8_t fence_char;
  uint8_t fence_len;
  /* The spec version the front matter selects: 1 or 2. */
  uint8_t spec;
  /* The open containers, outermost first: how many, and the colon count of each (up to MAX_CONTAINERS). */
  uint16_t depth;
  uint8_t colons[MAX_CONTAINERS];
} Scanner;

static bool v2(const Scanner *scanner) { return scanner->spec >= 2; }

/* ------------------------------------------------------------------ character helpers */

static void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static bool is_blank(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }

static bool at_eol(TSLexer *lexer) { return lexer->eof(lexer) || lexer->lookahead == '\n'; }

static bool is_digit(int32_t c) { return c >= '0' && c <= '9'; }

static bool is_lower(int32_t c) { return c >= 'a' && c <= 'z'; }

static bool is_alpha(int32_t c) { return (c >= 'A' && c <= 'Z') || is_lower(c); }

static bool is_name_char(int32_t c) { return is_alpha(c) || is_digit(c) || c == '_' || c == '-'; }

/* JavaScript's \s, which the markdown-it rules use for `==mark==` and `$math$`. */
static bool is_js_space(int32_t c) {
  if (c == ' ' || (c >= '\t' && c <= '\r') || c == 0xA0 || c == 0x1680 || c == 0xFEFF) return true;
  return (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F ||
         c == 0x3000;
}

static void skip_blanks(TSLexer *lexer) {
  while (is_blank(lexer->lookahead)) advance(lexer);
}

static void skip_to_eol(TSLexer *lexer) {
  while (!at_eol(lexer)) advance(lexer);
}

static bool accept(TSLexer *lexer, enum TokenType type) {
  lexer->result_symbol = type;
  return true;
}

/* ------------------------------------------------------------------ attribute lists and labels */

/* After a `{`: consume through the `}` that closes the attribute list on this line (quotes may hold
 * `}`), as findAttrsEnd does. False for a newline or a `{` first. `items`, when given, is set to
 * whether the list has items and each is an `#id`, a `.class` or a `key=value`, which spec v2 asks of
 * a heading's trailing list (sections.ts headingAttrList): `{}` and `{word}` are heading text there. */
static bool scan_attrs_items(TSLexer *lexer, bool *items) {
  int32_t quote = 0;
  bool any = false, ok = true, in_item = false, item_ok = false;
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (quote) {
      if (c == quote) quote = 0;
      continue;
    }
    if (c == '}' || is_blank(c)) {
      if (in_item && !item_ok) ok = false;
      in_item = false;
      if (c == '}') {
        if (items) *items = any && ok;
        return true;
      }
      continue;
    }
    if (c == '{') return false;
    if (!in_item) {
      in_item = any = true;
      item_ok = c == '#' || c == '.';
    }
    if (c == '=') item_ok = true;
    if (c == '"' || c == '\'') quote = c;
  }
  return false;
}

static bool scan_attrs_rest(TSLexer *lexer) { return scan_attrs_items(lexer, NULL); }

/* After a `[`: consume through its matching `]` on this line (nested brackets balance, `\` escapes). */
static bool scan_label_rest(TSLexer *lexer) {
  int depth = 1;
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '\\') {
      if (!at_eol(lexer)) advance(lexer);
    } else if (c == '[') {
      depth++;
    } else if (c == ']' && --depth == 0) {
      return true;
    }
  }
  return false;
}

/* The text between a validated `[` and its matching `]`, which is not consumed. */
static bool scan_label_content(TSLexer *lexer, enum TokenType type) {
  int depth = 0;
  bool any = false;
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    if (c == ']') {
      if (depth == 0) break;
      depth--;
    } else if (c == '[') {
      depth++;
    }
    advance(lexer);
    if (c == '\\' && !at_eol(lexer)) advance(lexer);
    any = true;
  }
  lexer->mark_end(lexer);
  return any && accept(lexer, type);
}

/* ------------------------------------------------------------------ inline openers */

/* After the `:` of a directive: a name (lower case in spec v1, any case in v2), then a complete
 * `[…]`, a complete `{…}` or both. */
static bool scan_directive_rest(const Scanner *scanner, TSLexer *lexer) {
  bool (*letter)(int32_t) = v2(scanner) ? is_alpha : is_lower;
  if (!letter(lexer->lookahead)) return false;
  while (letter(lexer->lookahead) || is_digit(lexer->lookahead) || lexer->lookahead == '-') advance(lexer);
  bool content = false;
  if (lexer->lookahead == '[') {
    advance(lexer);
    if (!scan_label_rest(lexer)) return false;
    content = true;
  }
  if (lexer->lookahead == '{') {
    advance(lexer);
    return scan_attrs_rest(lexer);
  }
  return content;
}

/* `[text]{attrs}`: the `[` when a matching `]` is directly followed by a complete attribute list. */
static bool scan_span_open(TSLexer *lexer) {
  advance(lexer);
  lexer->mark_end(lexer);
  if (lexer->lookahead == '^') return false; /* a footnote reference */
  if (!scan_label_rest(lexer) || lexer->lookahead != '{') return false;
  advance(lexer);
  return scan_attrs_rest(lexer) && accept(lexer, SPAN_OPEN);
}

/* `{{name}}` after the first `{`: not `{{{`, and not followed by another `}`. */
static bool scan_variable_rest(TSLexer *lexer) {
  advance(lexer);
  lexer->mark_end(lexer);
  if (lexer->lookahead == '{') return false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
  if (!is_alpha(lexer->lookahead) && lexer->lookahead != '_') return false;
  while (is_name_char(lexer->lookahead)) advance(lexer);
  while (lexer->lookahead == '.') {
    advance(lexer);
    if (!is_name_char(lexer->lookahead)) return false;
    while (is_name_char(lexer->lookahead)) advance(lexer);
  }
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
  for (int i = 0; i < 2; i++) {
    if (lexer->lookahead != '}') return false;
    advance(lexer);
  }
  return lexer->lookahead != '}' && accept(lexer, VARIABLE_OPEN);
}

/* A `{`: a variable, an attribute list after a name (ATTR_OPEN) or one that ends the line (in spec
 * v2 only with recognisable items, see scan_attrs_items). */
static bool scan_brace(const Scanner *scanner, TSLexer *lexer, const bool *valid) {
  advance(lexer);
  if (lexer->lookahead == '{') return valid[VARIABLE_OPEN] && scan_variable_rest(lexer);
  lexer->mark_end(lexer);
  bool items = false;
  if (!scan_attrs_items(lexer, &items)) return false;
  if (valid[ATTR_OPEN]) return accept(lexer, ATTR_OPEN);
  if (!valid[TRAILING_ATTR_OPEN] || (v2(scanner) && !items)) return false;
  skip_blanks(lexer);
  return at_eol(lexer) && accept(lexer, TRAILING_ATTR_OPEN);
}

/* `==text==`: no blank or `=` after the opener, and the first `==` after it not preceded by a blank. */
static bool scan_mark_open(TSLexer *lexer) {
  advance(lexer);
  if (lexer->lookahead != '=') return false;
  advance(lexer);
  lexer->mark_end(lexer);
  int32_t prev = lexer->lookahead;
  if (at_eol(lexer) || prev == '=' || is_js_space(prev)) return false;
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '=' && lexer->lookahead == '=') return !is_js_space(prev) && accept(lexer, MARK_OPEN);
    prev = c;
  }
  return false;
}

/* The text of a mark, up to the first `==`. */
static bool scan_mark_content(TSLexer *lexer) {
  bool any = false;
  while (!at_eol(lexer)) {
    bool equals = lexer->lookahead == '=';
    advance(lexer);
    if (equals && lexer->lookahead == '=') break;
    lexer->mark_end(lexer);
    any = true;
  }
  return any && accept(lexer, MARK_CONTENT);
}

/* Whether a `$` closes inline math: not after `\` or a blank, and not before a digit. */
static bool closes_math(int32_t prev, TSLexer *lexer) {
  return prev != '\\' && !is_js_space(prev) && !is_digit(lexer->lookahead);
}

/* `$math$` after the opening `$` (Pandoc rules: no blank inside the delimiters, no digit after). */
static bool scan_math_open_rest(TSLexer *lexer) {
  lexer->mark_end(lexer);
  int32_t prev = lexer->lookahead;
  if (at_eol(lexer) || prev == '$' || is_js_space(prev)) return false;
  prev = '$';
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '$' && closes_math(prev, lexer)) return accept(lexer, MATH_OPEN);
    prev = c;
  }
  return false;
}

/* The LaTeX of inline math, up to its closing `$`. */
static bool scan_math_content(TSLexer *lexer) {
  int32_t prev = '$';
  bool any = false;
  while (!at_eol(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '$' && closes_math(prev, lexer)) break;
    lexer->mark_end(lexer);
    any = true;
    prev = c;
  }
  return any && accept(lexer, MATH_CONTENT);
}

/* ------------------------------------------------------------------ display math */

typedef struct {
  bool marking;  /* content mode: mark the end of the token as text is consumed */
  bool marked;   /* something was marked */
  unsigned text; /* non-blank characters on the line before its closing `$$` run */
  unsigned run;  /* length of that run */
} MathLine;

static void math_mark(TSLexer *lexer, MathLine *line) {
  if (!line->marking) return;
  lexer->mark_end(lexer);
  line->marked = true;
}

/* The rest of a line of `$$` math. True when it ends with a run of 2+ `$` and blanks (a closer),
 * which is left out of the marked text. */
static bool scan_math_line(TSLexer *lexer, MathLine *line) {
  line->text = 0;
  line->run = 0;
  while (!at_eol(lexer)) {
    if (lexer->lookahead != '$') {
      if (!is_blank(lexer->lookahead)) line->text++;
      advance(lexer);
      math_mark(lexer, line);
      continue;
    }
    unsigned run = 0;
    while (lexer->lookahead == '$') {
      advance(lexer);
      run++;
    }
    skip_blanks(lexer);
    if (at_eol(lexer) && run >= 2) {
      line->run = run;
      return true;
    }
    line->text += run;
    math_mark(lexer, line);
  }
  return false;
}

/* Spec v2: a line inside `$$` math. True for a line that is only `$$` (and blanks), the closer,
 * which is left out of the marked text; any other line is math. */
static bool scan_math_line_v2(TSLexer *lexer, MathLine *line) {
  skip_blanks(lexer);
  math_mark(lexer, line);
  unsigned run = 0;
  while (lexer->lookahead == '$') {
    advance(lexer);
    run++;
  }
  skip_blanks(lexer);
  if (run == 2 && at_eol(lexer)) return true;
  skip_to_eol(lexer);
  math_mark(lexer, line);
  return false;
}

/* After an opening `$$`: through the line that closes it, as mathBlock does (containers.ts
 * displayMathOpener and closesDisplayMath). On the first line, `$$ x $$` closes. Spec v1: any other
 * line starting with `$$` opens a block closed by the next line ending in `$$`. Spec v2: only `$$`
 * alone opens one (text beside it is not math), closed by the next line that is only `$$`. */
static bool scan_math_block_body(const Scanner *scanner, TSLexer *lexer, MathLine *line) {
  if (scan_math_line(lexer, line) && (line->text > 0 || line->run > 2)) return true;
  if (v2(scanner) && (line->text > 0 || line->run > 0)) return false;
  math_mark(lexer, line);
  while (!lexer->eof(lexer)) {
    advance(lexer); /* the newline */
    math_mark(lexer, line);
    if (v2(scanner) ? scan_math_line_v2(lexer, line) : scan_math_line(lexer, line)) return true;
  }
  return false;
}

static bool scan_math_block(const Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (valid[MATH_BLOCK_CONTENT]) {
    MathLine line = {true, false, 0, 0};
    if (!scan_math_block_body(scanner, lexer, &line)) return false;
    if (line.marked) return accept(lexer, MATH_BLOCK_CONTENT);
    /* `$$$$$`: nothing between the delimiters, so this is the closer. */
    lexer->mark_end(lexer);
    return accept(lexer, MATH_BLOCK_CLOSE);
  }
  unsigned run = 0;
  while (lexer->lookahead == '$') {
    advance(lexer);
    run++;
  }
  skip_blanks(lexer);
  lexer->mark_end(lexer);
  return run >= 2 && accept(lexer, MATH_BLOCK_CLOSE);
}

/* ------------------------------------------------------------------ fenced code */

/* At a line start: whether it closes the open fence (same character, at least as many, then
 * nothing but blanks). Consumes the line up to its end when it does. */
static bool closes_fence(Scanner *scanner, TSLexer *lexer) {
  skip_blanks(lexer);
  unsigned n = 0;
  while (lexer->lookahead == scanner->fence_char) {
    advance(lexer);
    n++;
  }
  if (n < scanner->fence_len) return false;
  skip_blanks(lexer);
  return at_eol(lexer);
}

static bool scan_code_fence_open(Scanner *scanner, TSLexer *lexer) {
  int32_t ch = lexer->lookahead;
  unsigned n = 0;
  while (lexer->lookahead == ch) {
    advance(lexer);
    n++;
  }
  if (n < 3) return false;
  lexer->mark_end(lexer);
  if (ch == '`') {
    /* A backtick fence's info string has no backticks (CommonMark). */
    while (!at_eol(lexer)) {
      if (lexer->lookahead == '`') return false;
      advance(lexer);
    }
  }
  scanner->fence_char = (uint8_t)ch;
  scanner->fence_len = (uint8_t)(n > 255 ? 255 : n);
  return accept(lexer, CODE_FENCE_OPEN);
}

static bool scan_code(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (scanner->fence_len == 0 || lexer->eof(lexer)) return false;
  if (closes_fence(scanner, lexer)) {
    if (!valid[CODE_FENCE_CLOSE]) return false;
    lexer->mark_end(lexer);
    scanner->fence_char = 0;
    scanner->fence_len = 0;
    return accept(lexer, CODE_FENCE_CLOSE);
  }
  if (!valid[CODE_CONTENT]) return false;
  for (;;) {
    skip_to_eol(lexer);
    if (!lexer->eof(lexer)) advance(lexer); /* the newline */
    lexer->mark_end(lexer);
    if (lexer->eof(lexer) || closes_fence(scanner, lexer)) break;
  }
  return accept(lexer, CODE_CONTENT);
}

/* ------------------------------------------------------------------ front matter */

/* At a line start: `---` or `...` and nothing else but blanks. */
static bool closes_front_matter(TSLexer *lexer) {
  int32_t ch = lexer->lookahead;
  if (ch != '-' && ch != '.') return false;
  for (int i = 0; i < 3; i++) {
    if (lexer->lookahead != ch) return false;
    advance(lexer);
  }
  skip_blanks(lexer);
  return at_eol(lexer);
}

/* `---` on the first line, when a later line closes it (front matter that is never closed is not
 * front matter). */
static bool scan_front_matter_open(TSLexer *lexer) {
  for (int i = 0; i < 3; i++) {
    if (lexer->lookahead != '-') return false;
    advance(lexer);
  }
  skip_blanks(lexer);
  lexer->mark_end(lexer);
  if (lexer->lookahead != '\n') return false;
  while (!lexer->eof(lexer)) {
    advance(lexer); /* the newline */
    if (closes_front_matter(lexer)) return accept(lexer, FRONT_MATTER_OPEN);
    skip_to_eol(lexer);
  }
  return false;
}

/* At a line start: -1 when the line is not a top-level `smd:` key, else its value as specVersion.ts
 * reads it. A whole number, plain (`2`, `2.0`) or quoted (`"2"`), with an optional comment; anything
 * else is 0, which reads as spec v1 like an invalid value. Values above 2 read with the newest rules,
 * as spec v2. */
static int scan_smd_key(TSLexer *lexer) {
  static const char key[] = "smd";
  for (int i = 0; key[i]; i++) {
    if (lexer->lookahead != key[i]) return -1;
    advance(lexer);
  }
  skip_blanks(lexer);
  if (lexer->lookahead != ':') return -1;
  advance(lexer);
  /* YAML reads `smd:2` as text, not a key: the colon must be followed by a blank. */
  if (!is_blank(lexer->lookahead) && !at_eol(lexer)) return -1;
  skip_blanks(lexer);
  int32_t quote = lexer->lookahead == '"' || lexer->lookahead == '\'' ? lexer->lookahead : 0;
  if (quote) advance(lexer);
  unsigned value = 0;
  bool digits = false;
  while (is_digit(lexer->lookahead)) {
    value = value * 10 + (unsigned)(lexer->lookahead - '0');
    if (value > 9) value = 9; /* any larger whole number reads as the newest version */
    digits = true;
    advance(lexer);
  }
  if (!digits) return 0;
  if (quote) {
    if (lexer->lookahead != quote) return 0;
    advance(lexer);
  } else if (lexer->lookahead == '.') {
    /* `2.0` is the number 2; `2.5` is not a whole number. */
    advance(lexer);
    while (lexer->lookahead == '0') advance(lexer);
  }
  bool blank = is_blank(lexer->lookahead);
  skip_blanks(lexer);
  if (lexer->lookahead == '#' && blank) skip_to_eol(lexer);
  return at_eol(lexer) ? (int)value : 0;
}

static bool scan_front_matter_body(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (closes_front_matter(lexer)) {
    lexer->mark_end(lexer);
    return valid[FRONT_MATTER_CLOSE] && accept(lexer, FRONT_MATTER_CLOSE);
  }
  if (!valid[FRONT_MATTER_CONTENT]) return false;
  int version = 0;
  unsigned keys = 0;
  for (;;) {
    int value = lexer->lookahead == 's' ? scan_smd_key(lexer) : -1;
    if (value >= 0) {
      version = value;
      keys++;
    }
    skip_to_eol(lexer);
    if (lexer->eof(lexer)) return false;
    advance(lexer); /* the newline */
    lexer->mark_end(lexer);
    if (closes_front_matter(lexer)) {
      /* A repeated key is a YAML error, and front matter that doesn't parse is spec v1. */
      scanner->spec = keys == 1 && version >= 2 ? 2 : 1;
      return accept(lexer, FRONT_MATTER_CONTENT);
    }
  }
}

/* ------------------------------------------------------------------ block starts */

/* ------------------------------------------------------------------ containers */

static void push_container(Scanner *scanner, unsigned colons) {
  if (scanner->depth < MAX_CONTAINERS) scanner->colons[scanner->depth] = (uint8_t)(colons > 255 ? 255 : colons);
  if (scanner->depth < UINT16_MAX) scanner->depth++;
}

static void pop_container(Scanner *scanner) {
  if (scanner->depth > 0) scanner->depth--;
}

/* Spec v2: whether a closing fence with `colons` colons closes a container around the innermost
 * one, which then ends without a fence of its own (markdownItRules.ts closeWith). A fence that
 * matches the innermost container, or none, closes the innermost, as in spec v1. */
static bool closes_outer(const Scanner *scanner, unsigned colons) {
  if (!v2(scanner) || scanner->depth < 2 || scanner->depth > MAX_CONTAINERS) return false;
  uint8_t n = (uint8_t)(colons > 255 ? 255 : colons);
  unsigned inner = scanner->depth - 1u;
  if (scanner->colons[inner] == n) return false;
  while (inner-- > 0) {
    if (scanner->colons[inner] == n) return true;
  }
  return false;
}

/* A run of colons: a container fence (3+, then a name or the end of the line) or, a single one
 * not preceded by blanks in this token, a directive. A closing fence that closes a container
 * around the innermost one first ends the inner ones (CONTAINER_END, empty: the scanner sees the
 * same fence again after each). */
static bool scan_colons(Scanner *scanner, TSLexer *lexer, const bool *valid, bool indented) {
  unsigned n = 0;
  while (lexer->lookahead == ':') {
    advance(lexer);
    n++;
  }
  if (n >= 3 && valid[CONTAINER_FENCE]) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
    if (is_alpha(lexer->lookahead)) {
      lexer->mark_end(lexer);
      push_container(scanner, n);
      return accept(lexer, CONTAINER_FENCE);
    }
    skip_blanks(lexer);
    if (!at_eol(lexer)) return false;
    if (valid[CONTAINER_END] && closes_outer(scanner, n)) {
      pop_container(scanner);
      return accept(lexer, CONTAINER_END); /* empty: the end was marked at the line start */
    }
    lexer->mark_end(lexer);
    pop_container(scanner);
    return accept(lexer, CONTAINER_FENCE);
  }
  if (n != 1 || indented || !valid[DIRECTIVE_MARKER]) return false;
  lexer->mark_end(lexer);
  return scan_directive_rest(scanner, lexer) && accept(lexer, DIRECTIVE_MARKER);
}

static bool scan_dollar(const Scanner *scanner, TSLexer *lexer, const bool *valid, bool indented) {
  advance(lexer);
  if (lexer->lookahead == '$') {
    if (!valid[MATH_BLOCK_OPEN]) return false;
    advance(lexer);
    lexer->mark_end(lexer);
    MathLine line = {false, false, 0, 0};
    return scan_math_block_body(scanner, lexer, &line) && accept(lexer, MATH_BLOCK_OPEN);
  }
  return !indented && valid[MATH_OPEN] && scan_math_open_rest(lexer);
}

/* Tokens that start with a given character, at a line start (block) or inside a line. */
static bool scan_opener(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  bool block = valid[CONTAINER_FENCE];
  bool indented = false;
  if (block) {
    lexer->mark_end(lexer); /* an empty CONTAINER_END ends here */
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(lexer);
      indented = true;
    }
  }
  switch (lexer->lookahead) {
    case ':':
      return scan_colons(scanner, lexer, valid, indented);
    case '$':
      return scan_dollar(scanner, lexer, valid, indented);
    case '`':
    case '~':
      return block && valid[CODE_FENCE_OPEN] && scan_code_fence_open(scanner, lexer);
    default:
      break;
  }
  if (indented) return false; /* the blanks are text; the scanner runs again after them */
  switch (lexer->lookahead) {
    case '[':
      /* After a directive name, `[` starts its content (an internal token), not a span. */
      return valid[SPAN_OPEN] && !valid[ATTR_OPEN] && scan_span_open(lexer);
    case '{':
      return (valid[ATTR_OPEN] || valid[TRAILING_ATTR_OPEN] || valid[VARIABLE_OPEN]) && scan_brace(scanner, lexer, valid);
    case '=':
      return valid[MARK_OPEN] && scan_mark_open(lexer);
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ entry points */

void *tree_sitter_smd_external_scanner_create(void) {
  Scanner *scanner = ts_calloc(1, sizeof(Scanner));
  return scanner;
}

void tree_sitter_smd_external_scanner_destroy(void *payload) { ts_free(payload); }

/* fence_char, fence_len, spec, depth (2 bytes), then the colon counts kept (at most MAX_CONTAINERS). */
#define HEADER_SIZE 5

unsigned tree_sitter_smd_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = payload;
  unsigned kept = scanner->depth < MAX_CONTAINERS ? scanner->depth : MAX_CONTAINERS;
  buffer[0] = (char)scanner->fence_char;
  buffer[1] = (char)scanner->fence_len;
  buffer[2] = (char)scanner->spec;
  buffer[3] = (char)(scanner->depth & 0xFF);
  buffer[4] = (char)(scanner->depth >> 8);
  for (unsigned i = 0; i < kept; i++) buffer[HEADER_SIZE + i] = (char)scanner->colons[i];
  return HEADER_SIZE + kept;
}

void tree_sitter_smd_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *scanner = payload;
  scanner->fence_char = 0;
  scanner->fence_len = 0;
  scanner->spec = 0;
  scanner->depth = 0;
  if (length < HEADER_SIZE) return;
  scanner->fence_char = (uint8_t)buffer[0];
  scanner->fence_len = (uint8_t)buffer[1];
  scanner->spec = (uint8_t)buffer[2];
  scanner->depth = (uint16_t)((uint8_t)buffer[3] | ((uint8_t)buffer[4] << 8));
  unsigned kept = length - HEADER_SIZE;
  if (kept > MAX_CONTAINERS) kept = MAX_CONTAINERS;
  for (unsigned i = 0; i < kept; i++) scanner->colons[i] = (uint8_t)buffer[HEADER_SIZE + i];
}

bool tree_sitter_smd_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid) {
  Scanner *scanner = payload;
  if (valid[ERROR_SENTINEL]) return false; /* error recovery: let the internal lexer resync */

  if (valid[CODE_CONTENT] || valid[CODE_FENCE_CLOSE]) return scan_code(scanner, lexer, valid);
  if (valid[MATH_BLOCK_CONTENT] || valid[MATH_BLOCK_CLOSE]) return scan_math_block(scanner, lexer, valid);
  if (valid[FRONT_MATTER_CONTENT] || valid[FRONT_MATTER_CLOSE]) return scan_front_matter_body(scanner, lexer, valid);
  if (valid[DIRECTIVE_CONTENT]) return scan_label_content(lexer, DIRECTIVE_CONTENT);
  if (valid[SPAN_CONTENT]) return scan_label_content(lexer, SPAN_CONTENT);
  if (valid[MARK_CONTENT]) return scan_mark_content(lexer);
  if (valid[MATH_CONTENT]) return scan_math_content(lexer);

  if (lexer->eof(lexer)) return valid[EOF_TOKEN] && accept(lexer, EOF_TOKEN);
  if (valid[FRONT_MATTER_OPEN] && lexer->lookahead == '-') return scan_front_matter_open(lexer);
  return scan_opener(scanner, lexer, valid);
}
