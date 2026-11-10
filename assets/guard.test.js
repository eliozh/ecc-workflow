'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = path.join(__dirname, 'guard.sh');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-workflow-guard-'));
}

function run(dir, ...args) {
  return spawnSync('bash', [guard, ...args], { cwd: dir, encoding: 'utf8' });
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('guard installs both rules and is idempotent', () => {
  const dir = tempProject();
  try {
    let result = run(dir, 'install', '--mode', 'feature');
    assert.equal(result.status, 0, result.stderr);
    const code = path.join(dir, '.claude/hookify.block-code-before-approval.local.md');
    const scaffold = path.join(dir, '.claude/hookify.block-scaffold-before-approval.local.md');
    assert.ok(fs.existsSync(code));
    assert.ok(fs.existsSync(scaffold));
    assert.match(fs.readFileSync(code, 'utf8'), /block-code-before-approval/);

    result = run(dir, 'install', '--mode', 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already current/);
  } finally {
    cleanup(dir);
  }
});

test('guard refreshes stale rule content', () => {
  const dir = tempProject();
  try {
    run(dir, 'install');
    const code = path.join(dir, '.claude/hookify.block-code-before-approval.local.md');
    fs.writeFileSync(code, 'stale');
    const result = run(dir, 'install');
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(code, 'utf8'), /block-code-before-approval/);
  } finally {
    cleanup(dir);
  }
});

test('guard status reports and remove deletes both rules', () => {
  const dir = tempProject();
  try {
    run(dir, 'install');
    let result = run(dir, 'status');
    assert.match(result.stdout, /active:/);

    result = run(dir, 'remove');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed 2 rule/);
    assert.ok(
      !fs.existsSync(path.join(dir, '.claude/hookify.block-code-before-approval.local.md')),
    );
    assert.ok(
      !fs.existsSync(path.join(dir, '.claude/hookify.block-scaffold-before-approval.local.md')),
    );
  } finally {
    cleanup(dir);
  }
});

test('guard rejects an unknown mode', () => {
  const dir = tempProject();
  try {
    const result = run(dir, 'install', '--mode', 'nope');
    assert.notEqual(result.status, 0);
  } finally {
    cleanup(dir);
  }
});
