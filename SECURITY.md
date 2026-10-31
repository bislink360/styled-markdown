# Security policy

## Supported versions

Security fixes go into the latest minor release. Styled Markdown releases every component (the VS Code extension, the `smd` CLI, the npm package `styled-markdown`, the agent skills, the MCP server, the GitHub Action and the other integrations) with one shared version, so "supported" means the same for all of them.

| Version | Supported |
|---|---|
| Latest minor (2.5.x today) | Yes |
| Older minors and majors | No: update to the latest release |

A fix ships as a patch release of the latest minor (for example 2.5.1). Upgrading within a major keeps your documents, commands and settings working; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Reporting a vulnerability

Please don't open a public issue or discussion for a security problem.

Report it privately through GitHub: **[Report a vulnerability](https://github.com/bislink360/styled-markdown/security/advisories/new)** (the repository's **Security** tab → **Report a vulnerability**). Only you and the maintainers can see the report. If that form isn't available, contact the maintainer, [@roshanmadhushanka](https://github.com/roshanmadhushanka), on GitHub and ask for a private channel, without details in public.

Include what you can:

- the component and version (`smd --version`, or the extension's version)
- a document, command or configuration that shows the problem
- what an attacker gains, and what they need first (for example "opens a crafted `.smd` file in the preview")

You can expect an acknowledgement within a week, and a fix or a plan within 30 days for a confirmed problem. We credit reporters in the release notes unless you'd rather not be named.

## What counts

Styled Markdown is built so that opening a document is safe. These are in scope:

- script execution, or HTML or CSS escaping the allowlist, in the VS Code preview, the exported HTML, `smd build` sites, the web playground or the npm renderers
- file embeds (`file="…"`) or `:::include` reading files outside the workspace or the document's folder
- the MCP server reading or writing outside its `--root`, or writing without `--allow-write`
- the CLI, GitHub Action or pre-commit hooks running commands or writing files they shouldn't
- supply-chain problems in the published packages or release assets

The playground's own threat model is in [playground/README.md](playground/README.md).
