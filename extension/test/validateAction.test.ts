import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

// The GitHub Action in validate/: action.yml passes its inputs to validate.sh as SMD_* variables.
const actionDir = join(__dirname, '..', '..', 'validate');
const script = join(actionDir, 'validate.sh');

interface Action { inputs: Record<string, { default: string }>; runs: { using: string; steps: Array<{ shell: string; env: Record<string, string>; run: string }> } }

test('action.yml is a composite action that hands every input to validate.sh through the environment', () => {
  const action = load(readFileSync(join(actionDir, 'action.yml'), 'utf8')) as Action;
  assert.equal(action.runs.using, 'composite');
  const [step] = action.runs.steps;
  assert.equal(step.shell, 'bash');
  assert.equal(step.run, 'bash "$GITHUB_ACTION_PATH/validate.sh"');
  for (const name of Object.keys(action.inputs)) {
    const variable = `SMD_${name.toUpperCase().replace(/-/g, '_')}`;
    assert.equal(step.env[variable], `\${{ inputs.${name} }}`, name);
    assert.ok(readFileSync(script, 'utf8').includes(variable), `validate.sh reads ${variable}`);
  }
  assert.deepEqual(Object.keys(action.inputs).sort((a, b) => a.localeCompare(b)), ['cli', 'config', 'fail-on', 'mermaid', 'paths', 'stale-after', 'strict', 'summary']);
  assert.equal(action.inputs['fail-on'].default, 'error');
});

// Git Bash on Windows; skipped where no bash with node on its PATH (e.g. only WSL's bash.exe).
const hasBash = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).status === 0;
test('validate.sh: annotations, job summary, paths with spaces and fail-on', { skip: !hasBash && 'bash with node not found' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-action-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_') && !key.startsWith('SMD_')));
  const run = (inputs: Record<string, string>) => spawnSync('bash', [script], {
    cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), SMD_MERMAID: 'false', ...inputs },
  });
  try {
    mkdirSync(join(dir, 'my docs'));
    mkdirSync(join(dir, 'clean'));
    writeFileSync(join(dir, 'my docs', 'warn.smd'), '# Warn\n\nSee [a](missing.smd).\n');
    writeFileSync(join(dir, 'clean', 'ok.smd'), '# Fine\n\nAll good.\n');

    const warn = run({ SMD_PATHS: 'my docs\r\n\nclean\n' });
    assert.equal(warn.status, 0, warn.stdout + warn.stderr);
    assert.match(warn.stdout, /^::warning file=my docs\/warn\.smd,line=3,col=\d+,endColumn=\d+,title=smd link\/missing-file::/m);
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /^## smd validate\n\n2 file\(s\) checked: \*\*0 error\(s\)\*\*, \*\*1 warning\(s\)\*\*\./);

    assert.equal(run({ SMD_PATHS: 'my docs', SMD_FAIL_ON: 'warning' }).status, 1);
    assert.equal(run({ SMD_PATHS: 'my docs', SMD_STRICT: 'true' }).status, 1);
    assert.equal(run({ SMD_PATHS: 'my docs', SMD_STRICT: 'true', SMD_FAIL_ON: 'never' }).status, 0);
    assert.equal(run({ SMD_PATHS: 'clean', SMD_STRICT: 'true' }).status, 0);
    const bad = run({ SMD_FAIL_ON: 'sometimes' });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /^::error title=smd validate::fail-on must be error, warning or never/);

    rmSync(join(dir, 'summary.md'));
    run({ SMD_PATHS: 'clean', SMD_SUMMARY: 'false' });
    assert.throws(() => readFileSync(join(dir, 'summary.md')), 'no job summary when summary is false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
