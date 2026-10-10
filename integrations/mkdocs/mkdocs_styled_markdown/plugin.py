"""MkDocs plugin: ``.smd`` files in ``docs_dir`` become pages, rendered by the Styled Markdown engine."""

from __future__ import annotations

import html
import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from mkdocs.config import config_options as c
from mkdocs.config.defaults import MkDocsConfig
from mkdocs.plugins import BasePlugin, get_plugin_logger
from mkdocs.structure.files import File, Files
from mkdocs.structure.nav import Navigation
from mkdocs.structure.pages import Page
from mkdocs.structure.toc import get_toc

from .bridge import NodeBridge

log = get_plugin_logger(__name__)

ASSET_DIR = "assets/styled-markdown"
STATIC = Path(__file__).with_name("assets")
KATEX_CSS = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">'
MERMAID_JS = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>'
ID_ATTR = re.compile(r'\sid="([^"]*)"')

# `validate: true`: smd errors become MkDocs warnings (so `mkdocs build --strict` fails), as `smd validate` fails on
# errors only; smd warnings are shown as info, information and hints only with `--verbose`.
LEVELS = {"error": logging.WARNING, "warning": logging.INFO}


class SmdFile(File):
    """A ``.smd`` document in ``docs_dir``, built as a page (MkDocs only treats Markdown extensions as pages)."""

    def is_documentation_page(self) -> bool:
        return True


def is_smd(file: File) -> bool:
    return file.src_uri.lower().endswith(".smd")


def smd_pages(files: Files) -> Files:
    """Replace each ``.smd`` file with a page; a ``.smd`` page wins over a ``.md`` page with the same URL (as in smd build)."""
    for file in [f for f in files if is_smd(f) and not isinstance(f, SmdFile)]:
        files.remove(file)
        files.append(SmdFile(file.src_path, file.src_dir, file.dest_dir, file.use_directory_urls, inclusion=file.inclusion))
    smd_dests = {f.dest_uri for f in files if isinstance(f, SmdFile)}
    for file in [f for f in files.documentation_pages() if not isinstance(f, SmdFile) and f.dest_uri in smd_dests]:
        log.warning(f"{file.src_uri} and a .smd document both build {file.dest_uri}; using the .smd document.")
        files.remove(file)
    return files


def toc_tokens(headings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """smd's headings as MkDocs table of contents tokens, nested by level like Python-Markdown's ``toc``."""
    root: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    for heading in headings:
        token = {"level": heading["level"], "id": heading["slug"], "name": html.escape(heading["text"]), "children": []}
        while stack and stack[-1]["level"] >= token["level"]:
            stack.pop()
        (stack[-1]["children"] if stack else root).append(token)
        stack.append(token)
    return root


def site_lang(config: MkDocsConfig) -> str:
    """The theme's locale as a language tag (`pt_BR` → `pt-BR`), for the labels smd adds; empty when unset."""
    locale = config.theme.get("locale")
    return str(locale).replace("_", "-") if locale else ""


def page_urls(files: Files) -> dict[str, str]:
    """Every page's source path → its URL relative to the site root (unquoted; the bridge encodes it)."""
    return {f.src_uri: unquote(f.url) for f in files.documentation_pages()}


class StyledMarkdownPlugin(BasePlugin):
    """Render ``.smd`` pages (and with ``md_syntax``, ``.md`` pages) with the Styled Markdown engine."""

    config_scheme = (
        ("md_syntax", c.Type(bool, default=False)),
        ("validate", c.Type(bool, default=False)),
        ("node", c.Type(str, default="node")),
    )

    def __init__(self) -> None:
        self._bridge: NodeBridge | None = None
        self._rendered: dict[str, dict[str, Any]] = {}
        self._cdn: dict[str, str] = {}

    # -- build lifecycle -------------------------------------------------------------------------------------

    def on_config(self, config: MkDocsConfig) -> MkDocsConfig:
        for name in ("smd.css", "mkdocs.css"):
            _add_once(config.extra_css, f"{ASSET_DIR}/{name}")
        # mkdocs.js first: it tells the runtime which theme (light or dark) the page shows.
        for name in ("mkdocs.js", "runtime.js"):
            _add_once(config.extra_javascript, f"{ASSET_DIR}/{name}")
        return config

    def on_files(self, files: Files, config: MkDocsConfig) -> Files:
        self._close()
        self._bridge = NodeBridge(self.config["node"])
        assets = self._bridge.call("assets")
        contents = {
            "smd.css": assets["css"],
            "runtime.js": assets["runtimeJs"],
            "mkdocs.css": (STATIC / "mkdocs.css").read_text(encoding="utf-8"),
            "mkdocs.js": (STATIC / "mkdocs.js").read_text(encoding="utf-8"),
        }
        for name, content in contents.items():
            _replace(files, File.generated(config, f"{ASSET_DIR}/{name}", content=content))
        return smd_pages(files)

    def on_nav(self, nav: Navigation, config: MkDocsConfig, files: Files) -> Navigation:
        self._call("site", docsDir=config.docs_dir, pages=page_urls(files), lang=site_lang(config))
        return nav

    def on_post_build(self, config: MkDocsConfig) -> None:
        self._close()

    def on_build_error(self, error: Exception) -> None:
        self._close()

    def on_shutdown(self) -> None:
        self._close()

    # -- pages -----------------------------------------------------------------------------------------------

    def on_page_markdown(self, markdown: str, page: Page, config: MkDocsConfig, files: Files) -> str:
        if not self._renders(page.file):
            return markdown
        smd = is_smd(page.file)
        result = self._call(
            "render",
            path=page.file.src_uri,
            text=page.file.content_string,
            header=smd,
            validate=bool(self.config["validate"] and smd),
        )
        self._report(page.file.src_uri, result.get("diagnostics") or [])
        if result.get("title"):
            page.meta["title"] = result["title"]
        self._rendered[page.file.src_uri] = result
        # Python-Markdown gets nothing to convert; on_page_content puts the rendered page in its place.
        return ""

    def on_page_content(self, html_content: str, page: Page, config: MkDocsConfig, files: Files) -> str:
        result = self._rendered.pop(page.file.src_uri, None)
        if result is None:
            return html_content
        body = result["html"]
        page.toc = get_toc(toc_tokens(result["headings"]))
        page.present_anchor_ids = {html.unescape(i) for i in ID_ATTR.findall(body)}
        self._cdn[page.file.src_uri] = _cdn_tags(body)
        return body

    def on_post_page(self, output: str, page: Page, config: MkDocsConfig) -> str:
        tags = self._cdn.pop(page.file.src_uri, "")
        if not tags or "</head>" not in output:
            return output
        return output.replace("</head>", f"{tags}\n</head>", 1)

    # -- helpers ---------------------------------------------------------------------------------------------

    def _renders(self, file: File) -> bool:
        return isinstance(file, SmdFile) or (self.config["md_syntax"] and file.is_documentation_page())

    def _call(self, method: str, **params: Any) -> Any:
        if self._bridge is None:
            self._bridge = NodeBridge(self.config["node"])
        return self._bridge.call(method, **params)

    def _report(self, source: str, diagnostics: list[dict[str, Any]]) -> None:
        for d in diagnostics:
            level = LEVELS.get(d["severity"], logging.DEBUG)
            log.log(level, f"{source}:{d['line']}:{d['column']}: {d['message']} [{d['code']}]")

    def _close(self) -> None:
        if self._bridge is not None:
            self._bridge.close()
            self._bridge = None
        self._rendered.clear()
        self._cdn.clear()


def _add_once(entries: list, value: str) -> None:
    if all(str(entry) != value for entry in entries):
        entries.append(value)


def _replace(files: Files, file: File) -> None:
    existing = files.get_file_from_path(file.src_uri)
    if existing is not None:
        files.remove(existing)
    files.append(file)


def _cdn_tags(body: str) -> str:
    """The KaTeX stylesheet and Mermaid for a page that has math or diagrams (the same rule as smd build)."""
    tags = []
    if 'class="katex' in body:
        tags.append(KATEX_CSS)
    if 'class="smd-mermaid"' in body:
        tags.append(MERMAID_JS)
    return "\n".join(tags)
