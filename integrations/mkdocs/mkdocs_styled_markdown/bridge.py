"""The Node process that renders Styled Markdown for the plugin.

The renderer is the same engine as the `smd` CLI and the VS Code extension, bundled as ``bridge.cjs``. The plugin
starts it once per build and sends it one JSON request per line on stdin; it answers each with one JSON line on
stdout, in order (see ``extension/src/mkdocsBridge.ts`` in the repository for the protocol).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from mkdocs.exceptions import PluginError

BRIDGE_SCRIPT = Path(__file__).with_name("bridge.cjs")
MIN_NODE = 18

NODE_MISSING = (
    "styled-markdown: Node.js {min}+ is needed to render .smd pages, but {node!r} was not found on PATH. "
    "Install Node.js from https://nodejs.org (or your package manager), or set the plugin's `node` option "
    "to the node executable."
)


class NodeBridge:
    """One running ``node bridge.cjs``: ``call`` sends a request and returns its result."""

    def __init__(self, node: str = "node") -> None:
        executable = shutil.which(node)
        if executable is None:
            raise PluginError(NODE_MISSING.format(min=MIN_NODE, node=node))
        self._stderr = tempfile.TemporaryFile()
        self._process = subprocess.Popen(
            [executable, str(BRIDGE_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
        )
        self._last_id = 0
        self.info = self.call("hello")
        major = int(str(self.info.get("node", "0")).split(".")[0])
        if major < MIN_NODE:
            self.close()
            raise PluginError(f"styled-markdown: Node.js {MIN_NODE}+ is needed, found {self.info.get('node')}.")

    def call(self, method: str, **params: Any) -> Any:
        """Send one request and wait for its answer. Raises PluginError for an error answer or a dead process."""
        self._last_id += 1
        request = json.dumps({"id": self._last_id, "method": method, "params": params}) + "\n"
        stdin, stdout = self._process.stdin, self._process.stdout
        if stdin is None or stdout is None or stdin.closed:
            raise PluginError("styled-markdown: the Node.js renderer is not running.")
        try:
            stdin.write(request.encode("utf-8"))
            stdin.flush()
        except OSError as error:
            raise PluginError(self._stopped()) from error
        line = stdout.readline()
        if not line:
            raise PluginError(self._stopped())
        response = json.loads(line.decode("utf-8"))
        if "error" in response:
            raise PluginError(f"styled-markdown: {response['error'].get('message', 'unknown error')}")
        return response.get("result")

    def close(self) -> None:
        """Stop the process: it exits when its stdin closes."""
        if self._process.stdin and not self._process.stdin.closed:
            try:
                self._process.stdin.close()
            except OSError:
                pass
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()
        if self._process.stdout:
            self._process.stdout.close()
        self._stderr.close()

    def _stopped(self) -> str:
        """The message for a bridge that stopped answering, with what it printed."""
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.kill()
        self._stderr.seek(0)
        output = self._stderr.read().decode("utf-8", "replace").strip()
        detail = f":\n{output}" if output else "."
        return f"styled-markdown: the Node.js renderer stopped (Node.js {MIN_NODE}+ is needed){detail}"
