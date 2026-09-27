# Examples

Every example is a valid `.smd` file with a rendered `.html` file next to it. Download the HTML and open it in a browser to see the result without VS Code.

| Example | Type | Highlights |
|---|---|---|
| [showcase.smd](showcase.smd) | Tour | Every feature on one page, including an `{agent=skip}` section and a code embed |
| [checkout-redesign.smd](checkout-redesign.smd) | PRD | Realistic product spec: KPIs, tabs of requirements with owners and due dates, API blocks, decisions, risks, timeline, open question, agent constraints, human-only background |
| [feature-spec.smd](feature-spec.smd) | Short spec | A compact spec with a status table, tabs, flowchart, gantt and API columns |
| [adr-0007-event-bus.smd](adr-0007-event-bus.smd) | ADR | Accepted and superseded decisions, options table, consequences, risk, rules for implementers |
| [runbook-payments-latency.smd](runbook-payments-latency.smd) | Runbook | Danger box, triage steps, mitigation tabs, escalation, safe-automation rules for agents |
| [api-orders.smd](api-orders.smd) | API reference | Endpoint blocks, errors table, changelog timeline, source embedded from `src/pricing.ts` with highlighted lines |
| [status-report-2026-09.smd](status-report-2026-09.smd) | Status report | KPI tiles, progress, next-week tasks, risk, decision needed |

`src/pricing.ts` is a small source file that the examples embed with ```` ```ts file="src/pricing.ts" lines="…" ````.

## Try the agent tools on them

```bash
# from the repository root (or use `smd` if it's on your PATH)
SMD="node skills/styled-markdown-reader/scripts/smd.cjs"

$SMD outline examples/checkout-redesign.smd
$SMD agent examples/checkout-redesign.smd --section requirements
$SMD agent examples/runbook-payments-latency.smd --brief
$SMD tasks examples
$SMD validate examples
```

## Regenerate the HTML

```bash
for f in examples/*.smd; do node extension/dist/cli.js render "$f" -o "${f%.smd}.html"; done
```
