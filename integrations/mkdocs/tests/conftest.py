"""A tiny MkDocs site with .smd pages, built with the real `mkdocs build` in a temporary folder."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

GUIDE = """\
---
title: Smd Guide
status: draft
---

## Setup

:::warning Mind the gap
Callout body.
:::

::::tabs
:::tab npm
`npm install`
:::
:::tab pnpm
`pnpm add`
:::
::::

- [x] Write the plugin
- [ ] Ship it

:::figure{#fig-logo} The logo
![Logo](img/logo.png)
:::

See :ref[fig-logo] and the [other page](other.smd#second-part).

:::include{file="_partials/terms.smd"}
See the terms.
:::

### Deep dive

Done.
"""

OTHER = """\
# Other page

## Second part

Back to the [guide](guide.smd) and [home](index.md).
"""

TERMS = """\
## Terms

Included terms text.
"""

INDEX = """\
# Home

Read the [smd guide](guide.smd) and its [setup](guide.smd#setup).
"""

MKDOCS_YML = """\
site_name: Smd test
theme:
  name: mkdocs
exclude_docs: |
  _partials/
plugins:
  - search
  - styled-markdown{options}
"""


class Site:
    """A docs folder with mkdocs.yml, and `build()` that runs mkdocs in a subprocess."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.docs = root / "docs"
        self.out = root / "site"

    def write(self, path: str, text: str) -> None:
        target = self.docs / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def config(self, **options: object) -> None:
        lines = "".join(f"\n      {key}: {_yaml(value)}" for key, value in options.items())
        text = MKDOCS_YML.format(options=":" + lines if options else "")
        (self.root / "mkdocs.yml").write_text(text, encoding="utf-8")

    def build(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, "-m", "mkdocs", "build", "--site-dir", str(self.out), *args]
        return subprocess.run(command, cwd=self.root, capture_output=True, text=True, encoding="utf-8", env=env, check=False)

    def page(self, path: str) -> str:
        return (self.out / path).read_text(encoding="utf-8")


def _yaml(value: object) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


@pytest.fixture
def site(tmp_path: Path) -> Site:
    s = Site(tmp_path)
    s.write("index.md", INDEX)
    s.write("guide.smd", GUIDE)
    s.write("other.smd", OTHER)
    s.write("_partials/terms.smd", TERMS)
    (s.docs / "img").mkdir()
    (s.docs / "img" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    s.config()
    return s


