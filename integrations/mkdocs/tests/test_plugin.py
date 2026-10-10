"""End-to-end tests: real `mkdocs build` runs (default `mkdocs` theme) of the site in conftest.py."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest
from mkdocs.exceptions import PluginError

from mkdocs_styled_markdown import bridge as bridge_module
from mkdocs_styled_markdown.bridge import NodeBridge
from mkdocs_styled_markdown.plugin import toc_tokens

BROKEN = """\
---
title: Broken
---

## Broken

:::warning
Never closed.

[Nowhere](nowhere.smd)
"""


def ok(result) -> None:
    assert result.returncode == 0, result.stderr


def test_smd_page_renders_blocks_include_links_and_title(site):
    ok(site.build())
    page = site.page("guide/index.html")
    assert "<title>Smd Guide - Smd test</title>" in page
    assert '<h1 class="smd-doc-title">Smd Guide</h1>' in page
    assert 'class="smd-callout smd-callout-warning' in page
    assert 'class="smd-tabs"' in page and 'data-title="pnpm"' in page
    assert re.search(r'<input type="checkbox" class="smd-task-box"[^>]*checked aria-label="Write the plugin">', page)
    assert '<span class="smd-figure-label">Figure 1:</span> The logo</figcaption>' in page
    assert '<a class="smd-ref" href="#fig-logo">Figure 1</a>' in page
    assert "Included terms text." in page and "See the terms." not in page
    assert '<a href="../other/#second-part">other page</a>' in page
    assert '<img src="../img/logo.png" alt="Logo">' in page
    assert not (site.out / "_partials").exists()


def test_links_between_md_and_smd_pages(site):
    ok(site.build())
    home = site.page("index.html")
    assert '<a href="guide/">smd guide</a>' in home
    assert '<a href="guide/#setup">setup</a>' in home
    other = site.page("other/index.html")
    assert '<a href="../guide/">guide</a>' in other
    assert '<a href="../">home</a>' in other
    assert '<a href="other/" class="nav-link">Other page</a>' in home


def test_links_without_directory_urls(site):
    (site.root / "mkdocs.yml").write_text((site.root / "mkdocs.yml").read_text() + "use_directory_urls: false\n")
    ok(site.build())
    assert '<a href="other.html#second-part">other page</a>' in site.page("guide.html")
    assert '<a href="guide.html#setup">setup</a>' in site.page("index.html")


def test_toc_comes_from_smd_headings(site):
    ok(site.build())
    page = site.page("guide/index.html")
    # The mkdocs theme shows two levels (navigation_depth: 2); the h1 is smd's header, not a TOC entry.
    toc = re.findall(r'data-bs-level="(\d)"><a href="#([^"]+)"', page)
    assert toc == [("2", "setup"), ("2", "terms")]
    assert 'id="deep-dive"' in page
    index = json.loads((site.out / "search" / "search_index.json").read_text(encoding="utf-8"))
    locations = {doc["location"] for doc in index["docs"]}
    assert {"guide/", "guide/#setup", "guide/#deep-dive", "other/#second-part"} <= locations


def test_toc_tokens_nest_by_level():
    tokens = toc_tokens([
        {"level": 1, "text": "A & B", "slug": "a"},
        {"level": 2, "text": "C", "slug": "c"},
        {"level": 3, "text": "D", "slug": "d"},
        {"level": 2, "text": "E", "slug": "e"},
    ])
    assert [t["name"] for t in tokens] == ["A &amp; B"]
    assert [t["id"] for t in tokens[0]["children"]] == ["c", "e"]
    assert tokens[0]["children"][0]["children"][0]["id"] == "d"


def test_assets_are_added_and_ordered(site):
    ok(site.build())
    page = site.page("index.html")
    assert page.index("assets/styled-markdown/smd.css") < page.index("assets/styled-markdown/mkdocs.css")
    assert page.index("assets/styled-markdown/mkdocs.js") < page.index("assets/styled-markdown/runtime.js")
    css = (site.out / "assets" / "styled-markdown" / "smd.css").read_text(encoding="utf-8")
    assert ".smd-code .hljs" in css
    assert not re.search(r"^\.hljs", css, re.MULTILINE), "code colors stay inside .smd code frames"
    script = (site.out / "assets" / "styled-markdown" / "mkdocs.js").read_text(encoding="utf-8")
    # Reads the theme's mode and writes data-smd-theme-pref, which runtime.js follows.
    assert "dataset.bsTheme" in script
    assert "dataset.mdColorScheme" in script
    assert "dataset.smdThemePref = mode" in script


def test_math_and_diagrams_load_their_cdn_files(site):
    site.write("diagram.smd", "# Diagram\n\n$E = mc^2$\n\n```mermaid\nflowchart LR\n  A --> B\n```\n")
    ok(site.build())
    page = site.page("diagram/index.html")
    head = page[: page.index("</head>")]
    assert "katex.min.css" in head and "mermaid.min.js" in head
    assert "mermaid.min.js" not in site.page("guide/index.html")


def test_validate_reports_errors_as_warnings(site):
    site.write("broken.smd", BROKEN)
    site.config(validate=True)
    result = site.build()
    ok(result)
    assert re.search(r"WARNING\s+-\s+mkdocs_styled_markdown: broken\.smd:7:1: .* is never closed\..*\[container/unclosed\]", result.stderr), result.stderr
    assert re.search(r"INFO\s+-\s+mkdocs_styled_markdown: broken\.smd:10:11: .*\[link/missing-file\]", result.stderr), result.stderr


def test_strict_build_fails_on_smd_errors(site):
    site.write("broken.smd", BROKEN)
    site.config(validate=True)
    result = site.build("--strict")
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "container/unclosed" in output
    assert "Aborted with 1 warnings in strict mode" in output, output


def test_strict_build_passes_without_validate(site):
    site.write("broken.smd", BROKEN)
    result = site.build("--strict")
    ok(result)
    assert "container/unclosed" not in result.stderr


def test_md_syntax_option(site):
    site.write("notes.md", "# Notes\n\n:::tip Hint\nUse smd.\n:::\n")
    ok(site.build())
    assert "smd-callout" not in site.page("notes/index.html")
    site.config(md_syntax=True)
    ok(site.build())
    page = site.page("notes/index.html")
    assert 'class="smd-callout smd-callout-tip' in page
    assert "smd-doc-header" not in page, ".md pages get no front matter header"
    assert "<title>Notes - Smd test</title>" in page


def test_smd_page_wins_over_md_page_with_the_same_url(site):
    site.write("other.md", "# Plain other\n")
    result = site.build()
    ok(result)
    assert "other.md and a .smd document both build other/index.html" in result.stderr
    assert "Second part" in site.page("other/index.html")


def test_missing_node_on_path_fails_with_a_clear_message(site):
    env = dict(os.environ, PATH=str(Path(sys.executable).parent))
    result = site.build(env=env)
    assert result.returncode != 0
    assert "Node.js 18+ is needed to render .smd pages, but 'node' was not found on PATH" in result.stderr


def test_node_option_names_the_executable(site):
    site.config(node="no-such-node-binary")
    result = site.build()
    assert result.returncode != 0
    assert "'no-such-node-binary' was not found on PATH" in result.stderr


def test_bridge_without_node_raises_plugin_error(monkeypatch):
    monkeypatch.setattr(bridge_module.shutil, "which", lambda _name: None)
    with pytest.raises(PluginError, match=r"Node\.js 18\+ is needed"):
        NodeBridge()


def test_bridge_protocol_errors_are_plugin_errors():
    bridge = NodeBridge()
    try:
        assert bridge.info["protocol"] == 1
        with pytest.raises(PluginError, match='Call "site" before "render"'):
            bridge.call("render", path="a.smd")
        assert bridge.call("hello")["protocol"] == 1, "the bridge keeps serving after an error"
    finally:
        bridge.close()


def test_package_version_matches_the_bundled_engine():
    from importlib.metadata import version

    bridge = NodeBridge()
    try:
        assert bridge.info["version"] == version("mkdocs-styled-markdown")
    finally:
        bridge.close()
