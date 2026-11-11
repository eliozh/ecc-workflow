'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = require('./state.js');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-workflow-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('greenfield init writes a v2 state atomically', () => {
  const dir = tempProject();
  try {
    const created = state.initState(dir, { mode: 'greenfield', project: 'demo' });
    assert.equal(created.version, state.VERSION);
    assert.equal(created.mode, 'greenfield');
    assert.equal(created.stage, 1);
    assert.equal(created.gates.G5.status, 'n/a');
    const onDisk = readJson(state.statePath(dir));
    assert.equal(onDisk.project, 'demo');
    assert.match(onDisk.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      fs.readdirSync(state.stateDir(dir)).some((name) => name.includes('.tmp-')),
      false,
    );
  } finally {
    cleanup(dir);
  }
});

test('begin sets in_flight and end clears it', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.beginState(dir, { role: 'implementer', step: '8.3', handoff: 'slices/01/implement.md' });
    let current = state.readState(dir);
    assert.equal(current.in_flight.role, 'implementer');
    assert.equal(current.in_flight.step, '8.3');
    assert.match(current.next_action, /re-dispatch implementer/);

    state.endState(dir, { next: 'Run verifier' });
    current = state.readState(dir);
    assert.equal(current.in_flight, null);
    assert.equal(current.next_action, 'Run verifier');
  } finally {
    cleanup(dir);
  }
});

test('set supports dotted paths and JSON values', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, ['milestone=2', 'current_slice=18-x', 'feature.slug=oauth']);
    const current = state.readState(dir);
    assert.equal(current.milestone, 2);
    assert.equal(current.current_slice, '18-x');
    assert.equal(current.feature.slug, 'oauth');
  } finally {
    cleanup(dir);
  }
});

test('set rejects prototype-polluting keys', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    assert.throws(() => state.setState(dir, ['__proto__.polluted=1']), /unsafe state key/);
    assert.equal({}.polluted, undefined);
  } finally {
    cleanup(dir);
  }
});

test('gate records status, time, and evidence', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.gateState(dir, ['G1', 'approved'], { evidence: '.claude/prds/demo.prd.md' });
    const current = state.readState(dir);
    assert.equal(current.gates.G1.status, 'approved');
    assert.equal(current.gates.G1.evidence, '.claude/prds/demo.prd.md');
    assert.match(current.gates.G1.at, /^\d{4}-\d{2}-\d{2}T/);

    state.gateState(dir, ['G1', 'pending']);
    assert.equal(state.readState(dir).gates.G1.at, undefined);
  } finally {
    cleanup(dir);
  }
});

test('slice updates a slice by id and refuses unknown ids', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, [
      'slices=[{"id":"01-signup","status":"pending"},{"id":"02-login","status":"pending"}]',
    ]);

    const updated = state.updateSlice(dir, '02-login', ['status=merged', 'pr=42']);
    const merged = updated.slices.find((slice) => slice.id === '02-login');
    assert.equal(merged.status, 'merged');
    assert.equal(merged.pr, 42);
    assert.equal(updated.slices.find((slice) => slice.id === '01-signup').status, 'pending');
    assert.throws(() => state.updateSlice(dir, '03-missing', ['status=merged']), /unknown slice/);
    assert.throws(() => state.updateSlice(dir, '02-login', ['id=renamed']), /cannot be changed/);
  } finally {
    cleanup(dir);
  }
});

test('slices import merges by id, preserves runtime fields, and appends new slices', () => {
  const dir = tempProject();
  const file = path.join(dir, 'slices.json');
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, [
      'slices=[{"id":"01-signup","title":"Sign up","status":"merged","issue":7,"pr":9}]',
    ]);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: '01-signup', title: 'Sign up revised' },
        { id: '02-login', title: 'Log in', ui: true },
      ]),
    );

    const imported = state.importSlices(dir, file);
    assert.equal(imported.slices[0].title, 'Sign up revised');
    assert.equal(imported.slices[0].status, 'merged');
    assert.equal(imported.slices[0].issue, 7);
    assert.equal(imported.slices[0].pr, 9);
    assert.equal(imported.slices[1].id, '02-login');
    assert.equal(imported.slices[1].status, 'pending');
    assert.equal(imported.slices[1].ui, true);
  } finally {
    cleanup(dir);
  }
});

test('slices import rejects duplicate ids in the file', () => {
  const dir = tempProject();
  const file = path.join(dir, 'slices.json');
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    fs.writeFileSync(file, JSON.stringify([{ id: '01-a' }, { id: '01-a' }]));
    assert.throws(() => state.importSlices(dir, file), /duplicate slice id/);
  } finally {
    cleanup(dir);
  }
});

test('set rejects protected keys and invalid values', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    assert.throws(() => state.setState(dir, ['gates.G1.status=approved']), /own command/);
    assert.throws(() => state.setState(dir, ['in_flight=null']), /own command/);
    assert.throws(() => state.setState(dir, ['stgae=8']), /unknown state key/);
    assert.throws(() => state.setState(dir, ['stage=99']), /unknown stage/);
    assert.throws(() => state.setState(dir, ['status=nope']), /unknown status/);
    assert.throws(() => state.setState(dir, ['mode=nope']), /unknown mode/);
  } finally {
    cleanup(dir);
  }
});

test('gate requires evidence and scopes G5 to a slice', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    assert.throws(() => state.gateState(dir, ['G1', 'approved']), /needs --evidence/);

    state.setState(dir, ['slices=[{"id":"01-a"}]']);
    assert.throws(
      () => state.gateState(dir, ['G5', 'approved'], { evidence: 'https://example.com/pr/1' }),
      /needs --slice/,
    );

    state.gateState(dir, ['G5', 'approved'], {
      evidence: 'https://example.com/pr/1',
      slice: '01-a',
    });
    assert.equal(state.readState(dir).gates.G5.slice, '01-a');

    state.gateState(dir, ['G5', 'pending'], { slice: '01-a' });
    const gate = state.readState(dir).gates.G5;
    assert.equal(gate.evidence, undefined);
    assert.equal(gate.evidence_hash, undefined);
    assert.equal(gate.at, undefined);
    assert.equal(gate.slice, '01-a');
  } finally {
    cleanup(dir);
  }
});

test('gate evidence is hashed and verified', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    const evidence = path.join(dir, 'prd.md');
    fs.writeFileSync(evidence, 'v1');
    state.gateState(dir, ['G1', 'approved'], { evidence });

    const gate = state.readState(dir).gates.G1;
    assert.match(gate.evidence_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(state.verifyGates(dir), []);

    fs.writeFileSync(evidence, 'v2');
    assert.match(state.verifyGates(dir).join(' '), /G1 evidence changed/);
  } finally {
    cleanup(dir);
  }
});

test('writeState refuses a stale read', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    const stale = state.readState(dir);
    state.setState(dir, ['milestone=2']);
    stale.milestone = 3;
    assert.throws(
      () => state.writeState(dir, stale, { snapshot: false }),
      /state changed since it was read/,
    );
  } finally {
    cleanup(dir);
  }
});

test('restore brings back the latest checkpoint', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, ['milestone=2']);
    state.checkpointState(dir);
    state.setState(dir, ['milestone=3']);

    const restored = state.restoreState(dir);
    assert.equal(restored.milestone, 2);
    assert.equal(state.readState(dir).milestone, 2);
  } finally {
    cleanup(dir);
  }
});

test('milestone records completion', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    const updated = state.milestoneState(dir, ['1', 'complete']);
    assert.equal(updated.milestones['1'].status, 'complete');
    assert.match(updated.milestones['1'].at, /^\d{4}-/);
    assert.throws(() => state.milestoneState(dir, ['1', 'nope']), /unknown milestone status/);
  } finally {
    cleanup(dir);
  }
});

test('hooks install creates a private settings file', () => {
  const dir = tempProject();
  try {
    state.installHooks(dir);
    assert.equal(fs.statSync(state.settingsPath(dir)).mode & 0o077, 0);
  } finally {
    cleanup(dir);
  }
});

test('begin records parallel roles and handoffs', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.beginState(dir, {
      roles: 'code-reviewer,security-reviewer',
      step: '9.1',
      handoffs: 'S/review-code.md,S/review-security.md',
    });
    const current = state.readState(dir).in_flight;
    assert.deepEqual(current.roles, ['code-reviewer', 'security-reviewer']);
    assert.deepEqual(current.handoffs, ['S/review-code.md', 'S/review-security.md']);
    assert.equal(current.role, 'code-reviewer');

    state.endState(dir, { next: 'Merge findings' });
    assert.equal(state.readState(dir).in_flight, null);
  } finally {
    cleanup(dir);
  }
});

test('goto resets affected gates and refuses forward moves', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, ['stage=8']);
    for (const id of ['G1', 'G2', 'G3', 'G4']) {
      state.gateState(dir, [id, 'approved'], { evidence: `https://example.com/${id}` });
    }

    const moved = state.gotoState(dir, 4, { guard: false });
    assert.equal(moved.stage, 4);
    assert.equal(moved.status, 'awaiting-gate');
    assert.equal(moved.gates.G1.status, 'approved');
    assert.equal(moved.gates.G2.status, 'pending');
    assert.equal(moved.gates.G3.status, 'pending');
    assert.equal(moved.gates.G4.status, 'approved');
    assert.throws(() => state.gotoState(dir, 10, { guard: false }), /only moves backward/);
  } finally {
    cleanup(dir);
  }
});

test('checkpoint writes a copy and keeps the directory bounded', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    fs.mkdirSync(state.checkpointDir(dir), { recursive: true });
    const base = Date.now() - 120000;
    for (let index = 0; index < 60; index += 1) {
      const stamp = new Date(base + index * 1000).toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(state.checkpointDir(dir), `${stamp}-dummy.json`), '{}');
    }
    const manual = state.checkpointState(dir);
    const files = fs.readdirSync(state.checkpointDir(dir));
    assert.equal(files.length, 50);
    assert.ok(files.includes(path.basename(manual)));
  } finally {
    cleanup(dir);
  }
});

test('feature init pauses the milestone and resets the feature gates', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.gateState(dir, ['G1', 'approved'], { evidence: 'prd.md' });
    state.setState(dir, ['milestone=2', 'current_slice=18-x', 'next_action=Build slice 18']);

    const created = state.initState(dir, { mode: 'feature', slug: 'oauth-login' });
    assert.equal(created.mode, 'feature');
    assert.equal(created.stage, 'F1');
    assert.equal(created.milestone, 3);
    assert.equal(created.gates.G1.status, 'pending');
    assert.equal(created.gates.G2.status, 'pending');
    assert.equal(created.gates.G3.status, 'pending');
    assert.equal(created.paused.milestone, 2);
    assert.equal(created.paused.mode, 'greenfield');
    assert.equal(created.paused.current_slice, '18-x');
    assert.equal(created.paused.next_action, 'Build slice 18');
    assert.equal(created.paused.gates.G1.status, 'approved');
    assert.equal(created.feature.slug, 'oauth-login');
  } finally {
    cleanup(dir);
  }
});

test('a second feature run is refused while one is active', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.initState(dir, { mode: 'feature', slug: 'first' });
    assert.throws(
      () => state.initState(dir, { mode: 'feature', slug: 'second' }),
      /feature run is already active/,
    );
  } finally {
    cleanup(dir);
  }
});

test('finish-feature restores the paused milestone and gates', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.gateState(dir, ['G1', 'approved'], { evidence: 'prd.md' });
    state.gateState(dir, ['G4', 'approved'], { evidence: 'ci-run' });
    state.setState(dir, [
      'stage=8',
      'milestone=2',
      'current_slice=18-x',
      'next_action=Build slice 18',
      'prd=.claude/prds/demo.prd.md',
      'plan=.claude/plans/demo.plan.md',
    ]);
    state.initState(dir, { mode: 'feature', slug: 'oauth-login' });
    state.setState(dir, ['plan=.claude/plans/feature.plan.md']);

    const restored = state.finishFeatureState(dir);
    assert.equal(restored.prd, '.claude/prds/demo.prd.md');
    assert.equal(restored.plan, '.claude/plans/demo.plan.md');
    assert.equal(restored.mode, 'greenfield');
    assert.equal(restored.stage, 8);
    assert.equal(restored.milestone, 2);
    assert.equal(restored.current_slice, '18-x');
    assert.equal(restored.next_action, 'Build slice 18');
    assert.equal(restored.gates.G1.status, 'approved');
    assert.equal(restored.gates.G4.status, 'approved');
    assert.equal(restored.feature, null);
    assert.equal(restored.paused, undefined);

    const archived = fs.readdirSync(state.archiveDir(dir));
    assert.ok(archived.some((name) => name.startsWith('feature-oauth-login-')));
  } finally {
    cleanup(dir);
  }
});

test('finish-feature restores a paused maintain run', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, ['mode=maintain', 'stage=11']);
    state.initState(dir, { mode: 'feature', slug: 'maintenance-feature' });
    const restored = state.finishFeatureState(dir);
    assert.equal(restored.mode, 'maintain');
    assert.equal(restored.stage, 11);
  } finally {
    cleanup(dir);
  }
});

test('a second feature run gets a fresh milestone number', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'greenfield', project: 'demo' });
    state.setState(dir, ['milestone=2']);
    const first = state.initState(dir, { mode: 'feature', slug: 'first' });
    assert.equal(first.milestone, 3);
    state.finishFeatureState(dir);
    const second = state.initState(dir, { mode: 'feature', slug: 'second' });
    assert.equal(second.milestone, 4);
  } finally {
    cleanup(dir);
  }
});

test('parseArgs supports --key=value', () => {
  const { args, opts } = state.parseArgs(['init', '--mode=feature', '--slug=x']);
  assert.deepEqual(args, ['init']);
  assert.equal(opts.mode, 'feature');
  assert.equal(opts.slug, 'x');
});

test('slug is sanitized before it reaches paths and archive names', () => {
  const dir = tempProject();
  try {
    const created = state.initState(dir, { mode: 'feature', slug: '../../evil' });
    assert.equal(created.feature.slug, 'evil');
    assert.equal(created.feature.spec, '.claude/features/evil/spec.md');
    state.finishFeatureState(dir);
    const names = fs.readdirSync(state.archiveDir(dir));
    assert.ok(names.length > 0);
    assert.ok(names.every((name) => !name.includes('..')));
  } finally {
    cleanup(dir);
  }
});

test('finish-feature without a paused run enters maintain mode', () => {
  const dir = tempProject();
  try {
    state.initState(dir, { mode: 'feature', slug: 'solo' });
    const done = state.finishFeatureState(dir);
    assert.equal(done.mode, 'maintain');
    assert.equal(done.stage, 11);
    assert.equal(done.feature, null);
  } finally {
    cleanup(dir);
  }
});

test('hooks install preserves foreign hook groups', () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(
      state.settingsPath(dir),
      JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo foreign' }] }],
        },
      }),
    );
    state.installHooks(dir);
    const commands = readJson(state.settingsPath(dir)).hooks.PreCompact.flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    assert.ok(commands.includes('echo foreign'));
    assert.ok(commands.some((command) => command.includes('ecc-workflow-state')));
  } finally {
    cleanup(dir);
  }
});

test('hooks install refuses a non-array hook event', () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(state.settingsPath(dir), JSON.stringify({ hooks: { Stop: 'nope' } }));
    assert.throws(() => state.installHooks(dir), /must be an array/);
  } finally {
    cleanup(dir);
  }
});

test('corrupt state is reported and never overwritten', () => {
  const dir = tempProject();
  try {
    fs.mkdirSync(state.stateDir(dir), { recursive: true });
    fs.writeFileSync(state.statePath(dir), '{not json');
    assert.throws(() => state.initState(dir, { mode: 'greenfield' }), /not valid JSON/);
    assert.equal(fs.readFileSync(state.statePath(dir), 'utf8'), '{not json');
  } finally {
    cleanup(dir);
  }
});

test('hooks install merges settings and remove deletes only our entries', () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(
      state.settingsPath(dir),
      JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
    );

    state.installHooks(dir);
    let settings = readJson(state.settingsPath(dir));
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    for (const event of ['PreCompact', 'Stop', 'SessionEnd']) {
      assert.ok(settings.hooks[event].some((group) => group.hooks.some(state.isOurHook)));
    }

    state.installHooks(dir);
    settings = readJson(state.settingsPath(dir));
    const ours = settings.hooks.PreCompact.flatMap((group) => group.hooks.filter(state.isOurHook));
    assert.equal(ours.length, 1);

    state.removeHooks(dir);
    settings = readJson(state.settingsPath(dir));
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(settings.hooks, undefined);
  } finally {
    cleanup(dir);
  }
});

test('v1 state is upgraded on the next write', () => {
  const dir = tempProject();
  try {
    fs.mkdirSync(state.stateDir(dir), { recursive: true });
    fs.writeFileSync(
      state.statePath(dir),
      JSON.stringify({ version: 1, stage: 8, gates: {}, slices: [] }),
    );
    const current = state.readState(dir);
    assert.equal(current.mode, 'greenfield');
    state.endState(dir, { next: 'Continue' });
    assert.equal(readJson(state.statePath(dir)).version, 2);
  } finally {
    cleanup(dir);
  }
});
