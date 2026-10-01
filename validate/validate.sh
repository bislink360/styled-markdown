#!/usr/bin/env bash
# Runs `smd validate --format github` for the composite action in action.yml. Inputs arrive as SMD_*
# environment variables (never interpolated into the script). Exit code: 0 ok, 1 problems that fail
# the step under fail-on/strict, 2 bad input or a missing Node.js.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="${SMD_CLI:-}"
if [ -z "$cli" ]; then cli="$here/../skills/styled-markdown-reader/scripts/smd.cjs"; fi

usage_error() {
  echo "::error title=smd validate::$1"
  exit 2
}

if ! command -v node > /dev/null 2>&1; then
  usage_error "Node.js 18 or later is required: add actions/setup-node before this step."
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  usage_error "Node.js 18 or later is required (found $(node --version)): add actions/setup-node before this step."
fi
if [ ! -f "$cli" ]; then usage_error "smd CLI not found: $cli"; fi

args=(validate)
# One path per line; blank lines and Windows line endings are ignored, spaces inside a path are kept.
while IFS= read -r line; do
  line="${line%$'\r'}"
  if [ -n "${line//[[:space:]]/}" ]; then args+=("$line"); fi
done <<< "${SMD_PATHS:-.}"
if [ "${#args[@]}" -eq 1 ]; then args+=(.); fi
args+=(--format github)

case "${SMD_FAIL_ON:-error}" in
  error | never) ;;
  warning) args+=(--strict) ;;
  *) usage_error "fail-on must be error, warning or never (got \"${SMD_FAIL_ON}\")." ;;
esac
if [ "${SMD_STRICT:-false}" = "true" ]; then args+=(--strict); fi
if [ -n "${SMD_CONFIG:-}" ]; then args+=(--config "$SMD_CONFIG"); fi
if [ "${SMD_MERMAID:-true}" = "false" ]; then args+=(--no-mermaid); fi
if [ -n "${SMD_STALE_AFTER:-}" ]; then args+=(--stale-after "$SMD_STALE_AFTER"); fi
if [ "${SMD_SUMMARY:-true}" = "true" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  args+=(--summary "$GITHUB_STEP_SUMMARY")
fi

node "$cli" "${args[@]}"
status=$?
if [ "$status" -eq 1 ] && [ "${SMD_FAIL_ON:-error}" = "never" ]; then status=0; fi
exit "$status"
