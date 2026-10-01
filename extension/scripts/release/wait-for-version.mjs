#!/usr/bin/env node
// Waits until a registry lists a version, so a publish job only passes once users can install it.
//
//   node extension/scripts/release/wait-for-version.mjs <npm|marketplace|openvsx> <X.Y.Z> [--attempts 20] [--delay 30]
//
// npm:         https://registry.npmjs.org/styled-markdown/X.Y.Z
// marketplace: the Marketplace gallery query that `vsce show bislink360.styled-markdown` uses
// openvsx:     https://open-vsx.org/api/bislink360/styled-markdown/X.Y.Z
// Exits 0 when the version is listed, 1 after the last attempt. Reads public endpoints only.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'styled-markdown';
export const EXTENSION = 'bislink360.styled-markdown';
const MARKETPLACE_QUERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const INCLUDE_VERSIONS = 0x1;
const BY_NAME = 7;

/** The request that answers "is this version listed?" for a registry, or undefined for an unknown one. */
export function registryRequest(registry, version) {
  if (registry === 'npm') return { url: `https://registry.npmjs.org/${PACKAGE}/${version}`, init: {} };
  if (registry === 'openvsx') return { url: `https://open-vsx.org/api/${EXTENSION.replace('.', '/')}/${version}`, init: {} };
  if (registry !== 'marketplace') return undefined;
  const body = { filters: [{ criteria: [{ filterType: BY_NAME, value: EXTENSION }] }], flags: INCLUDE_VERSIONS };
  return {
    url: MARKETPLACE_QUERY,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json;api-version=3.0-preview.1' },
      body: JSON.stringify(body),
    },
  };
}

/** Versions listed in a registry response body (parsed JSON). */
export function listedVersions(registry, json) {
  if (registry === 'marketplace') {
    const extension = json?.results?.[0]?.extensions?.[0];
    return (extension?.versions ?? []).map((entry) => entry.version);
  }
  return json?.version ? [json.version] : [];
}

/** One lookup: true when the registry lists the version. Network and HTTP errors count as "not yet". */
export async function isListed(registry, version, fetchImpl = fetch) {
  const { url, init } = registryRequest(registry, version);
  try {
    const response = await fetchImpl(url, init);
    if (!response.ok) return false;
    return listedVersions(registry, await response.json()).includes(version);
  } catch {
    return false;
  }
}

/** Polls until the version is listed; resolves to true, or false after `attempts` tries. */
export async function waitForVersion(registry, version, { attempts = 20, delayMs = 30_000, fetchImpl = fetch, log = console.log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await isListed(registry, version, fetchImpl)) {
      log(`${registry}: ${version} is listed.`);
      return true;
    }
    log(`${registry}: ${version} not listed yet (attempt ${attempt}/${attempts}).`);
    if (attempt < attempts) await new Promise((done) => setTimeout(done, delayMs));
  }
  return false;
}

function parseArgs(argv) {
  const options = { registry: undefined, version: undefined, attempts: 20, delay: 30 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--attempts') options.attempts = Number(argv[++i]);
    else if (argv[i] === '--delay') options.delay = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  [options.registry, options.version] = positional;
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const valid = /^\d+\.\d+\.\d+$/.test(options.version ?? '') && Number.isInteger(options.attempts) && options.attempts > 0 && options.delay >= 0;
  if (!valid || !registryRequest(options.registry, options.version)) {
    console.error('Usage: wait-for-version.mjs <npm|marketplace|openvsx> <X.Y.Z> [--attempts 20] [--delay 30]');
    return 2;
  }
  const listed = await waitForVersion(options.registry, options.version, { attempts: options.attempts, delayMs: options.delay * 1000 });
  if (!listed) console.error(`::error::${options.registry} does not list ${options.version} after ${options.attempts} attempts.`);
  return listed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
