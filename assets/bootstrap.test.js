'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bootstrap = path.join(__dirname, 'bootstrap.sh');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-workflow-bootstrap-'));
}

function run(dir) {
  return spawnSync('bash', [bootstrap], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ECC Test',
      GIT_AUTHOR_EMAIL: 'ecc-test@example.invalid',
      GIT_COMMITTER_NAME: 'ECC Test',
      GIT_COMMITTER_EMAIL: 'ecc-test@example.invalid',
    },
  });
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('bootstrap initializes an empty folder', () => {
  const dir = tempDir();
  try {
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    assert.ok(fs.existsSync(path.join(dir, '.claude/hookify.block-code-before-approval.local.md')));
    assert.ok(
      fs.existsSync(path.join(dir, '.claude/hookify.block-scaffold-before-approval.local.md')),
    );
    const ignored = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    for (const line of [
      '.claude/*.local.md',
      '.claude/settings.local.json',
      '.claude/ecc-workflow/',
      '.env',
    ]) {
      assert.ok(ignored.includes(line), `missing ${line}`);
    }
  } finally {
    cleanup(dir);
  }
});

test('bootstrap refuses a non-empty folder', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# existing\n');
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /folder is not empty/);
  } finally {
    cleanup(dir);
  }
});
