#!/usr/bin/env node
// Decides whether a publish job of the release workflow publishes, and says why when it doesn't.
//
//   TOKEN=… DRY_RUN=true|false node extension/scripts/release/publish-gate.mjs <npm|marketplace|openvsx> <X.Y.Z> <SECRET_NAME> [--output <file>]
//
// Skips (with a ::notice::) on a dry run, when the secret is missing (TOKEN empty), or when the
// registry already lists the version (so re-running a release is safe). Appends "ready=true|false"
// to --output (pass "$GITHUB_OUTPUT"). Never prints the token; it only checks that one is set.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isListed, registryRequest } from './wait-for-version.mjs';

export const REGISTRY_NAMES = { npm: 'npm', marketplace: 'VS Code Marketplace', openvsx: 'Open VSX' };

/**
 * Whether to publish, and the notice to show when not.
 * @param {{ registry: string, version: string, secret: string, dryRun: boolean, hasToken: boolean, listed?: boolean }} state
 * @returns {{ ready: boolean, notice?: string }}
 */
export function publishDecision({ registry, version, secret, dryRun, hasToken, listed }) {
  const name = REGISTRY_NAMES[registry] ?? registry;
  if (dryRun) return { ready: false, notice: `Dry run: ${version} was not published to ${name}.` };
  if (!hasToken) {
    return { ready: false, notice: `${secret} is not set, so ${version} was not published to ${name}. Add the repository secret (smd-release skill, §7) and re-run this workflow for the tag.` };
  }
  if (listed) return { ready: false, notice: `${name} already lists ${version}; nothing to publish.` };
  return { ready: true };
}

async function main(argv) {
  const outIndex = argv.indexOf('--output');
  const output = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const [registry, version, secret] = outIndex >= 0 ? argv.slice(0, outIndex) : argv;
  if (!registryRequest(registry, version ?? '') || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !secret) {
    console.error('Usage: publish-gate.mjs <npm|marketplace|openvsx> <X.Y.Z> <SECRET_NAME> [--output <file>]');
    return 2;
  }
  const dryRun = process.env.DRY_RUN === 'true';
  const hasToken = Boolean(process.env.TOKEN?.trim());
  const listed = !dryRun && hasToken ? await isListed(registry, version) : undefined;
  const decision = publishDecision({ registry, version, secret, dryRun, hasToken, listed });
  if (decision.notice) console.log(`::notice title=${REGISTRY_NAMES[registry]}::${decision.notice}`);
  else console.log(`Publishing ${version} to ${REGISTRY_NAMES[registry]}.`);
  if (output) appendFileSync(output, `ready=${decision.ready}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
