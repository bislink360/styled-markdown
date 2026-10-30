# Publishing to agent registries

Maintainer notes for the listings that sit outside the tag-triggered Release workflow (which publishes the VS Code Marketplace, Open VSX, npm and the GitHub release). Users don't need this page; their side is in [INSTALL.md](INSTALL.md#claude-code-plugin).

## Claude Code plugin marketplace

Nothing to publish. The repository is the marketplace: `.claude-plugin/marketplace.json` lists one plugin, `styled-markdown`, whose root is the repository root (`"source": "./"`), and `.claude-plugin/plugin.json` declares it:

- **Skills:** found in `skills/<name>/SKILL.md`, so both `styled-markdown-reader` and `styled-markdown-writer`. The loose `skills/agent-rules.md` isn't a skill folder and is ignored.
- **MCP server:** `smd`, declared inline in `plugin.json` as `node ${CLAUDE_PLUGIN_ROOT}/skills/styled-markdown-reader/scripts/smd.cjs mcp`. There is no root `.mcp.json`, so working on this repository doesn't start the server.
- **Version:** `plugin.json`'s `version` pins what users get, so they update only when a release changes it. `bump-version.mjs` sets it with the other manifests, and `check-versions.mjs` fails a tag whose `plugin.json` doesn't match.

Users install from the default branch (`main`), which changes only when a release is merged, so a release reaches plugin users when its release branch is merged into `main`.

Check the manifests after changing them (Claude Code 2.1 or later):

```bash
claude plugin validate .                           # the marketplace and the plugin
claude --plugin-dir . plugin details styled-markdown   # skills, MCP server, always-on token cost
```

To list the plugin in Anthropic's plugin directory as well, submit it as described in the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins/publish.md).

## Official MCP Registry

`server.json` at the repository root describes the MCP server for the [MCP Registry](https://registry.modelcontextprotocol.io) as the npm package `styled-markdown`, run as `npx styled-markdown mcp`. The registry checks that the npm package belongs to the server by the `mcpName` in `npm/package.json` (`io.github.bislink360/styled-markdown`), so publish to the registry only **after** that version of the package is on npm. `bump-version.mjs` keeps `server.json`'s versions in step.

Once per machine, install the publisher:

```bash
brew install mcp-publisher
# or, on macOS and Linux:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

On Windows (PowerShell), then move `mcp-publisher.exe` to a folder on your `PATH`:

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

For each release, from the repository root on the tagged commit:

```bash
npm view styled-markdown@2.5.0 mcpName     # must print io.github.bislink360/styled-markdown
mcp-publisher login github                 # a GitHub account that is a member of the bislink360 organization
mcp-publisher publish                      # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bislink360/styled-markdown"
```

The `io.github.bislink360/` namespace is granted to members of the `bislink360` GitHub organization; if `publish` refuses the name, make your membership of the organization public and log in again.

**Before the first publish:** `npx styled-markdown mcp` needs the package to have a `styled-markdown` command (npm runs the command named like the package when it has more than one). Check that `npx -y styled-markdown@2.5.0 mcp` starts the server (it waits for input on stdin; stop it with Ctrl+C).
