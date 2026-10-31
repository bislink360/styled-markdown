#!/usr/bin/env node
// Uploads the JetBrains plugin zip attached to the GitHub Release to the JetBrains Marketplace.
//
//   JETBRAINS_TOKEN=… node extension/scripts/release/upload-jetbrains.mjs <styled-markdown-jetbrains-X.Y.Z.zip> <X.Y.Z>
//
// Uses the Marketplace's plugin upload API (POST https://plugins.jetbrains.com/plugin/uploadPlugin with
// pluginId and file). JetBrains reviews every upload by hand, so the version is listed only after that
// review; this script doesn't wait for it. An upload of a version the Marketplace already has counts as
// done, so re-running a release is safe. Never prints the token.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JETBRAINS_PLUGIN_ID } from './wait-for-version.mjs';

export const UPLOAD_URL = 'https://plugins.jetbrains.com/plugin/uploadPlugin';

/** The upload request: a multipart form with the plugin id and the zip. */
export function uploadRequest(zip, fileName, token, pluginId = JETBRAINS_PLUGIN_ID) {
  const form = new FormData();
  form.append('pluginId', String(pluginId));
  form.append('file', new Blob([zip], { type: 'application/zip' }), fileName);
  return { url: UPLOAD_URL, init: { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form } };
}

/**
 * What an upload response means.
 * @param {number} status HTTP status
 * @param {string} body response text
 * @param {string} version the version that was uploaded
 * @returns {{ ok: boolean, message: string }}
 */
export function uploadOutcome(status, body, version) {
  if (status >= 200 && status < 300) {
    return { ok: true, message: `Uploaded ${version} to the JetBrains Marketplace. It is listed once JetBrains approves it.` };
  }
  const text = body.trim().slice(0, 300);
  if (status === 400 && /already/i.test(text)) {
    return { ok: true, message: `The JetBrains Marketplace already has ${version}; nothing to upload. (${text})` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: `The JetBrains Marketplace refused the token (HTTP ${status}). Check JETBRAINS_TOKEN: it must belong to a developer of plugin ${JETBRAINS_PLUGIN_ID} and not be expired.` };
  }
  return { ok: false, message: `The JetBrains Marketplace upload failed (HTTP ${status}): ${text || 'no details'}` };
}

/** Uploads one zip; resolves to the outcome. Network errors count as a failed upload. */
export async function uploadPlugin(zipPath, version, token, fetchImpl = fetch) {
  const { url, init } = uploadRequest(readFileSync(zipPath), basename(zipPath), token);
  try {
    const response = await fetchImpl(url, init);
    return uploadOutcome(response.status, await response.text(), version);
  } catch (error) {
    return { ok: false, message: `The JetBrains Marketplace upload failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(argv) {
  const [zipPath, version] = argv;
  const token = process.env.JETBRAINS_TOKEN?.trim();
  if (!zipPath || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !token) {
    console.error('Usage: JETBRAINS_TOKEN=… upload-jetbrains.mjs <plugin zip> <X.Y.Z>');
    return 2;
  }
  const outcome = await uploadPlugin(zipPath, version, token);
  if (outcome.ok) console.log(`::notice title=JetBrains Marketplace::${outcome.message}`);
  else console.error(`::error::${outcome.message}`);
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
