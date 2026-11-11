#!/usr/bin/env node
/**
 * ecc-workflow state helper.
 *
 * Every state write goes through this file so that:
 *   - state.json is written atomically (temp file + rename),
 *   - updated_at is always fresh,
 *   - the previous version is kept in .claude/ecc-workflow/checkpoints/,
 *   - in_flight is easy to set before a subagent dispatch and clear after.
 *
 * Usage:
 *   node state.js status [--json]
 *   node state.js init --mode <greenfield|feature> [--project <name>]
 *                      [--slug <slug>] [--base-branch <branch>]
 *                      [--base-commit <sha>] [--spec <path>]
 *   node state.js set key=value [key=value ...]
 *   node state.js slice <id> key=value [key=value ...]
 *   node state.js slices import <file>
 *   node state.js milestone <n> <pending|in-progress|complete>
 *   node state.js goto <stage> [--no-guard]
 *   node state.js gate <G1..G6> <pending|approved|n/a|inherited> [--evidence <path-or-url>] [--slice <slice-id>]
 *   node state.js verify
 *   node state.js restore [<checkpoint-file>]
 *   node state.js begin --role <role> [--roles <a,b>] [--step <step>]
 *                       [--handoff <path>] [--handoffs <a,b>]
 *   node state.js end [--next "<next action>"]
 *   node state.js checkpoint [--auto]
 *   node state.js finish-feature
 *   node state.js hooks <install|remove|status>
 *   node state.js selftest
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = 2;
const KEEP_CHECKPOINTS = 50;
const HOOK_MARKER = 'ecc-workflow-state';
const HOOK_EVENTS = ['PreCompact', 'Stop', 'SessionEnd'];
const VALID_STATUSES = new Set(['in-progress', 'awaiting-gate', 'blocked', 'done']);
const VALID_MODES = new Set(['greenfield', 'feature', 'maintain']);
const PROTECTED_KEYS = new Set(['version', 'revision', 'updated_at', 'gates', 'in_flight']);
const SETTABLE_KEYS = new Set([
  'project',
  'base_branch',
  'mode',
  'stage',
  'status',
  'prd',
  'plan',
  'stack',
  'repo',
  'milestone',
  'milestone_seq',
  'milestones',
  'slices',
  'current_slice',
  'next_action',
  'feature',
  'protection',
]);

class StateError extends Error {}

function fail(message) {
  throw new StateError(message);
}

function now() {
  return new Date().toISOString();
}

function isoForFilename(iso) {
  return iso.replace(/[:.]/g, '-');
}

function safeSlug(value) {
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^[.-]+/, '');
  return cleaned || 'feature';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isValidStage(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 11;
  if (typeof value === 'string') return /^(F[0-7]|[0-9]|1[01])$/.test(value);
  return false;
}

function isUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || ''));
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function evidenceHash(root, evidence) {
  if (!evidence || isUrl(evidence)) return null;
  const target = path.isAbsolute(evidence) ? evidence : path.resolve(root, evidence);
  try {
    if (!fs.statSync(target).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  } catch (_) {
    return null;
  }
}

function gateWarnings(root, state) {
  const warnings = [];
  for (const [id, gate] of Object.entries(state.gates || {})) {
    if (!gate || !['approved', 'inherited'].includes(gate.status)) continue;
    if (!gate.evidence) {
      warnings.push(`${id} has no evidence`);
      continue;
    }
    if (!gate.evidence_hash) {
      if (!isUrl(gate.evidence)) {
        const target = path.isAbsolute(gate.evidence)
          ? gate.evidence
          : path.resolve(root, gate.evidence);
        if (!fs.existsSync(target)) warnings.push(`${id} evidence is missing`);
      }
      continue;
    }
    const target = path.isAbsolute(gate.evidence)
      ? gate.evidence
      : path.resolve(root, gate.evidence);
    let current = null;
    try {
      current = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    } catch (_) {
      warnings.push(`${id} evidence is missing`);
      continue;
    }
    if (current !== gate.evidence_hash) warnings.push(`${id} evidence changed`);
  }
  return warnings;
}

function writeFileAtomic(file, body, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `${path.basename(file)}.tmp-`;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (_) {
        /* a stale temp file that cannot be removed is harmless */
      }
    }
  }
  const temp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}`);
  const fd = fs.openSync(temp, 'w', mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (_) {
    /* directory fsync is best effort */
  }
}

function projectRoot() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function stateDir(root) {
  return path.join(root, '.claude', 'ecc-workflow');
}

function statePath(root) {
  return path.join(stateDir(root), 'state.json');
}

function checkpointDir(root) {
  return path.join(stateDir(root), 'checkpoints');
}

function archiveDir(root) {
  return path.join(stateDir(root), 'archive');
}

function settingsPath(root) {
  return path.join(root, '.claude', 'settings.local.json');
}

function readState(root, { required = true } = {}) {
  const file = statePath(root);
  if (!fs.existsSync(file)) {
    if (!required) return null;
    fail(`no state.json at ${file}; start with /ecc-workflow new or /ecc-workflow feature`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    fail(`state.json is not valid JSON (${error.message}); restore from ${checkpointDir(root)}`);
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    fail('state.json must be a JSON object');
  }
  if (state.version !== VERSION) {
    if (state.version === 1) {
      state.version = VERSION;
      state.mode = state.mode || 'greenfield';
    } else {
      fail(`unsupported state version ${state.version}`);
    }
  }
  state.mode = state.mode || 'greenfield';
  state.revision = state.revision ?? 0;
  state.in_flight = state.in_flight ?? null;
  return state;
}

function checkpointNames(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function latestCheckpoint(dir) {
  if (!fs.existsSync(dir)) return null;
  const names = checkpointNames(dir);
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function pruneCheckpoints(dir) {
  const names = checkpointNames(dir);
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_CHECKPOINTS))) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (_) {
      /* a checkpoint that cannot be pruned is harmless */
    }
  }
}

function checkpoint(root, state, label = 'auto') {
  const dir = checkpointDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const latest = latestCheckpoint(dir);
  if (latest) {
    try {
      if (fs.readFileSync(latest, 'utf8') === body) return latest;
    } catch (_) {
      /* fall through and write a fresh copy */
    }
  }
  const file = path.join(dir, `${isoForFilename(now())}-${label}.json`);
  writeFileAtomic(file, body, 0o600);
  pruneCheckpoints(dir);
  return file;
}

function writeState(root, state, { snapshot = true, label = 'auto' } = {}) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  const expected = state.revision;
  const previous = readState(root, { required: false });
  if (previous && expected !== undefined && previous.revision !== expected) {
    fail('state changed since it was read; re-read and retry');
  }
  if (snapshot && previous) checkpoint(root, previous, label);
  state.version = VERSION;
  state.revision = previous ? (previous.revision ?? 0) + 1 : 1;
  state.updated_at = now();
  writeFileAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return state;
}

function archiveBeforeFeature(root, state) {
  const file = path.join(archiveDir(root), `state-before-feature-${isoForFilename(now())}.json`);
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function archiveFeature(root, state) {
  const slug = safeSlug((state.feature && state.feature.slug) || 'feature');
  const file = path.join(archiveDir(root), `feature-${slug}-${isoForFilename(now())}.json`);
  const body = {
    feature: state.feature,
    gates: state.gates,
    paused: state.paused || null,
    slices: (state.slices || []).filter((slice) => slice.feature === slug),
    finished_at: now(),
  };
  writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`, 0o600);
}

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  if (parts.some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    fail(`unsafe state key: ${dotted}`);
  }
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      opts[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[body] = next;
      index += 1;
    } else {
      opts[body] = true;
    }
  }
  return { args, opts };
}

function initState(root, opts = {}) {
  const mode = opts.mode === 'feature' ? 'feature' : 'greenfield';
  if (opts.mode && !['greenfield', 'feature'].includes(opts.mode)) {
    fail(`unknown mode: ${opts.mode}`);
  }
  const existing = readState(root, { required: false });
  const baseBranch = opts['base-branch'] || (existing && existing.base_branch) || 'master';
  const slug = safeSlug(opts.slug || 'feature');

  if (!existing) {
    const state = {
      version: VERSION,
      project: opts.project || path.basename(root),
      base_branch: baseBranch,
      mode,
      stage: mode === 'feature' ? 'F1' : 1,
      status: 'in-progress',
      gates: {
        G1: { status: 'pending' },
        G2: { status: 'pending' },
        G3: { status: 'pending' },
        G4: { status: 'pending' },
        G5: { status: 'n/a' },
        G6: { status: mode === 'feature' ? 'n/a' : 'pending' },
      },
      prd: null,
      plan: null,
      stack: null,
      repo: null,
      milestone: 1,
      milestone_seq: 1,
      milestones: {},
      slices: [],
      current_slice: null,
      in_flight: null,
      next_action:
        mode === 'feature' ? `Dispatch feature-spec for ${slug}` : 'Run /ecc:plan-prd',
    };
    if (mode === 'feature') {
      state.feature = {
        slug,
        spec: opts.spec || `.claude/features/${slug}/spec.md`,
        base_commit: opts['base-commit'] || null,
        baseline: '.claude/ecc-workflow/handoffs/F0-baseline.md',
        started_at: now(),
      };
      state.paused = null;
    }
    return writeState(root, state, { snapshot: false });
  }

  if (existing.mode === 'feature') {
    fail('a feature run is already active; finish it with "finish-feature" before starting another');
  }
  if (mode !== 'feature') fail('state already exists; use /ecc-workflow resume');

  archiveBeforeFeature(root, existing);
  const milestoneSeq =
    Math.max(existing.milestone_seq ?? existing.milestone ?? 1, existing.milestone ?? 1) + 1;
  const state = {
    ...existing,
    version: VERSION,
    mode: 'feature',
    stage: 'F1',
    status: 'in-progress',
    feature: {
      slug,
      spec: opts.spec || `.claude/features/${slug}/spec.md`,
      base_commit: opts['base-commit'] || null,
      baseline: '.claude/ecc-workflow/handoffs/F0-baseline.md',
      started_at: now(),
    },
    paused: {
      mode: existing.mode ?? 'greenfield',
      milestone: existing.milestone ?? 1,
      current_slice: existing.current_slice ?? null,
      next_action: existing.next_action ?? null,
      stage: existing.stage ?? null,
      status: existing.status ?? null,
      prd: existing.prd ?? null,
      plan: existing.plan ?? null,
      stack: existing.stack ?? null,
      repo: existing.repo ?? null,
      gates: JSON.parse(JSON.stringify(existing.gates || {})),
    },
    milestone: milestoneSeq,
    milestone_seq: milestoneSeq,
    milestones: existing.milestones ?? {},
    gates: {
      ...(existing.gates || {}),
      G1: { status: 'pending' },
      G2: { status: 'pending' },
      G3: { status: 'pending' },
      G5: { status: 'n/a' },
      G6: { status: 'n/a' },
    },
    current_slice: null,
    in_flight: null,
    next_action: `Dispatch feature-spec for ${slug}`,
  };
  return writeState(root, state, { snapshot: true });
}

function setState(root, args) {
  if (args.length === 0) fail('usage: set key=value [key=value ...]');
  const state = readState(root);
  for (const pair of args) {
    const separator = pair.indexOf('=');
    if (separator < 1) fail(`bad assignment: ${pair}`);
    const dotted = pair.slice(0, separator);
    const parts = dotted.split('.');
    if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))) {
      fail(`unsafe state key: ${dotted}`);
    }
    const top = parts[0];
    const value = parseValue(pair.slice(separator + 1));
    if (PROTECTED_KEYS.has(top)) {
      fail(`${top} is written by its own command; use state.js gate/begin/end`);
    }
    if (!SETTABLE_KEYS.has(top)) fail(`unknown state key: ${top}`);
    if (top === 'stage' && !isValidStage(value)) fail(`unknown stage: ${value}`);
    if (top === 'status' && !VALID_STATUSES.has(value)) fail(`unknown status: ${value}`);
    if (top === 'mode' && !VALID_MODES.has(value)) fail(`unknown mode: ${value}`);
    setPath(state, dotted, value);
  }
  return writeState(root, state, { label: 'set' });
}

function findSlice(state, id) {
  const slices = Array.isArray(state.slices) ? state.slices : [];
  const slice = slices.find((item) => item && item.id === id);
  if (!slice) fail(`unknown slice: ${id}`);
  return slice;
}

function updateSlice(root, id, args) {
  if (!id) fail('usage: slice <id> key=value [key=value ...]');
  if (args.length === 0) fail('usage: slice <id> key=value [key=value ...]');
  const state = readState(root);
  const slice = findSlice(state, id);
  for (const pair of args) {
    const separator = pair.indexOf('=');
    if (separator < 1) fail(`bad assignment: ${pair}`);
    const key = pair.slice(0, separator);
    if (key === 'id') fail('a slice id cannot be changed');
    setPath(slice, key, parseValue(pair.slice(separator + 1)));
  }
  return writeState(root, state, { label: `slice-${safeSlug(id)}` });
}

function readSliceList(root, file) {
  if (!file) fail('usage: slices import <file>');
  const target = path.isAbsolute(file) ? file : path.resolve(root, file);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.slices)
      ? parsed.slices
      : null;
  if (!list) fail(`${file} must be an array of slices or an object with a "slices" array`);
  return list;
}

function importSlices(root, file) {
  const incoming = readSliceList(root, file);
  const state = readState(root);
  const merged = (Array.isArray(state.slices) ? state.slices : []).map((slice) => ({ ...slice }));
  const positions = new Map(merged.map((slice, index) => [slice.id, index]));
  const seen = new Set();
  for (const item of incoming) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('every imported slice must be a JSON object');
    }
    const id = String(item.id || '').trim();
    if (!id) fail('every imported slice needs an id');
    if (seen.has(id)) fail(`duplicate slice id in import: ${id}`);
    seen.add(id);
    const position = positions.get(id);
    if (position === undefined) {
      positions.set(id, merged.length);
      merged.push({ status: 'pending', ...item, id });
      continue;
    }
    const existing = merged[position];
    const next = { ...existing, ...item, id };
    for (const key of ['status', 'branch', 'issue', 'pr']) {
      if (item[key] === undefined) next[key] = existing[key];
    }
    if (next.status === undefined) next.status = 'pending';
    merged[position] = next;
  }
  state.slices = merged;
  return writeState(root, state, { label: 'slices-import' });
}

function gateState(root, args, opts = {}) {
  const [id, status] = args;
  if (!id || !status) {
    fail(
      'usage: gate <G1..G6> <pending|approved|n/a|inherited> [--evidence <path-or-url>] [--slice <slice-id>]',
    );
  }
  if (!/^G[1-6]$/.test(id)) fail(`unknown gate: ${id}`);
  if (!['pending', 'approved', 'n/a', 'inherited'].includes(status)) {
    fail(`unknown gate status: ${status}`);
  }
  const state = readState(root);
  if (opts.slice) {
    const slices = Array.isArray(state.slices) ? state.slices : [];
    if (!slices.some((slice) => slice && slice.id === opts.slice)) {
      fail(`unknown slice: ${opts.slice}`);
    }
  }
  if (id === 'G5' && (status === 'approved' || status === 'inherited') && !opts.slice) {
    fail('G5 needs --slice <slice-id>');
  }
  if ((status === 'approved' || status === 'inherited') && !opts.evidence) {
    fail(`${id} ${status} needs --evidence <path-or-url>`);
  }
  const previous = (state.gates && state.gates[id]) || {};
  const next = { ...previous, status };
  if (status === 'approved' || status === 'inherited') {
    next.at = now();
    next.evidence = opts.evidence;
    const hash = evidenceHash(root, opts.evidence);
    if (hash) next.evidence_hash = hash;
    else delete next.evidence_hash;
    if (opts.slice) next.slice = opts.slice;
  } else {
    delete next.at;
    delete next.evidence;
    delete next.evidence_hash;
    if (opts.slice) next.slice = opts.slice;
    else delete next.slice;
  }
  state.gates = { ...(state.gates || {}), [id]: next };
  return writeState(root, state, { label: `gate-${id}` });
}

function verifyGates(root) {
  const state = readState(root);
  return gateWarnings(root, state);
}

function restoreState(root, file) {
  const target = file || latestCheckpoint(checkpointDir(root));
  if (!target) fail(`no checkpoints in ${checkpointDir(root)}`);
  const resolved = path.isAbsolute(target) ? target : path.resolve(root, target);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    fail(`cannot read ${resolved}: ${error.message}`);
  }
  let restored;
  try {
    restored = JSON.parse(raw);
  } catch (error) {
    fail(`${resolved} is not valid JSON: ${error.message}`);
  }
  if (restored === null || typeof restored !== 'object' || Array.isArray(restored)) {
    fail(`${resolved} must contain a JSON object`);
  }
  if (fs.existsSync(statePath(root))) {
    const backup = `${statePath(root)}.before-restore-${isoForFilename(now())}`;
    try {
      fs.copyFileSync(statePath(root), backup);
    } catch (_) {
      /* a failed backup must not block the restore */
    }
  }
  restored.version = VERSION;
  restored.revision = (restored.revision ?? 0) + 1;
  restored.updated_at = now();
  writeFileAtomic(statePath(root), `${JSON.stringify(restored, null, 2)}\n`, 0o600);
  return restored;
}

function milestoneState(root, args) {
  const [number, status] = args;
  if (!number || !status) fail('usage: milestone <n> <pending|in-progress|complete>');
  if (!/^\d+$/.test(String(number))) fail(`bad milestone number: ${number}`);
  if (!['pending', 'in-progress', 'complete'].includes(status)) {
    fail(`unknown milestone status: ${status}`);
  }
  const state = readState(root);
  const key = String(number);
  const record = status === 'pending' ? { status } : { status, at: now() };
  state.milestones = { ...(state.milestones || {}), [key]: record };
  return writeState(root, state, { label: `milestone-${key}` });
}

function stageRank(stage) {
  if (typeof stage === 'number') return stage;
  const match = /^F([0-7])$/.exec(String(stage));
  return match ? 100 + Number(match[1]) : null;
}

function gatesToReset(target) {
  if (typeof target === 'number') {
    if (target === 0) return ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
    if (target === 1) return ['G1', 'G2', 'G3', 'G5', 'G6'];
    if (target <= 4) return ['G2', 'G3', 'G5', 'G6'];
    if (target <= 5) return ['G3', 'G5', 'G6'];
    if (target <= 7) return ['G4', 'G5', 'G6'];
    if (target <= 9) return ['G5', 'G6'];
    if (target <= 10) return ['G6'];
    return [];
  }
  const feature = Number(String(target).slice(1));
  if (feature === 0) return ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
  if (feature <= 2) return ['G1', 'G2', 'G3', 'G5', 'G6'];
  if (feature <= 4) return ['G2', 'G3', 'G5', 'G6'];
  if (feature <= 5) return ['G3', 'G5', 'G6'];
  if (feature <= 6) return ['G5', 'G6'];
  return ['G6'];
}

function gotoState(root, stage, opts = {}) {
  if (stage === undefined) fail('usage: goto <stage> [--no-guard]');
  const target = /^F[0-7]$/.test(String(stage)) ? String(stage) : Number(stage);
  if (!isValidStage(target)) fail(`unknown stage: ${stage}`);
  const state = readState(root);
  const currentRank = stageRank(state.stage);
  const targetRank = stageRank(target);
  if (currentRank === null || targetRank === null) {
    fail(`cannot compare stage ${state.stage} with ${target}`);
  }
  if (targetRank > currentRank) fail(`goto only moves backward: ${state.stage} -> ${target}`);
  if (state.in_flight) fail('a dispatch is in flight; run state.js end first');

  const reset = gatesToReset(target);
  const beforeG3 = typeof target === 'number'
    ? target <= 5
    : Number(String(target).slice(1)) <= 5;
  if (beforeG3 && opts.guard !== false) {
    const mode = state.mode === 'feature' ? 'feature' : 'greenfield';
    const result = spawnSync(
      'bash',
      [path.join(__dirname, 'guard.sh'), 'install', '--mode', mode],
      { cwd: root, stdio: 'ignore' },
    );
    if (result.status !== 0) fail('could not reinstall the guard; run guard.sh install and retry');
  }

  state.gates = state.gates || {};
  for (const id of reset) state.gates[id] = { status: 'pending' };
  const beforeStage8 = typeof target === 'number'
    ? target < 8
    : Number(String(target).slice(1)) <= 5;
  if (beforeStage8) state.current_slice = null;
  state.stage = target;
  state.status = 'awaiting-gate';
  state.next_action = `Re-run Stage ${target}; re-approve ${reset.join(', ') || 'no gates'}`;
  return writeState(root, state, { label: 'goto' });
}

function beginState(root, opts = {}) {
  if (!opts.role && !opts.roles) {
    fail('usage: begin --role <role> [--roles <a,b>] [--step <step>] [--handoff <path>] [--handoffs <a,b>]');
  }
  const state = readState(root);
  const roles = splitList(opts.roles || opts.role);
  const handoffs = splitList(opts.handoffs || opts.handoff);
  state.in_flight = {
    role: roles[0] || null,
    roles,
    step: opts.step || null,
    handoff: handoffs[0] || null,
    handoffs,
    started_at: now(),
  };
  const targets = handoffs.length ? handoffs.join(', ') : 'the handoff';
  const who = roles.join(', ');
  state.next_action = handoffs.length
    ? `Read ${targets} if each exists and has a complete status header; otherwise re-dispatch ${who}`
    : `Re-dispatch ${who} if it did not finish`;
  return writeState(root, state, { label: 'begin' });
}

function endState(root, opts = {}) {
  const state = readState(root);
  state.in_flight = null;
  if (opts.next) state.next_action = opts.next;
  return writeState(root, state, { label: 'end' });
}

function checkpointState(root) {
  const state = readState(root);
  return checkpoint(root, state, 'manual');
}

function finishFeatureState(root) {
  const state = readState(root);
  if (state.mode !== 'feature') fail('no active feature run');
  archiveFeature(root, state);
  if (state.paused) {
    state.mode = state.paused.mode || 'greenfield';
    state.stage = state.paused.stage ?? 8;
    state.status = state.paused.status ?? 'in-progress';
    state.milestone = state.paused.milestone ?? 1;
    state.current_slice = state.paused.current_slice ?? null;
    state.next_action = state.paused.next_action || 'Resume the paused milestone';
    state.prd = state.paused.prd ?? null;
    state.plan = state.paused.plan ?? null;
    state.stack = state.paused.stack ?? null;
    state.repo = state.paused.repo ?? null;
    if (state.paused.gates) state.gates = state.paused.gates;
    delete state.paused;
  } else {
    state.mode = 'maintain';
    state.stage = 11;
    state.status = 'in-progress';
    state.next_action = 'Feature complete. Ask for the next change or run /ecc-workflow release.';
  }
  state.feature = null;
  state.in_flight = null;
  return writeState(root, state, { label: 'finish-feature' });
}

function loadSettings(root) {
  const file = settingsPath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${file} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof StateError) throw error;
    fail(`${file} is not valid JSON: ${error.message}`);
  }
}

function writeSettings(root, settings) {
  let mode = 0o600;
  try {
    mode = fs.statSync(settingsPath(root)).mode & 0o777;
  } catch (_) {
    /* a new settings file starts private */
  }
  writeFileAtomic(settingsPath(root), `${JSON.stringify(settings, null, 2)}\n`, mode);
}

function hookCommand() {
  return `node ${shellQuote(path.resolve(__filename))} checkpoint --auto # ${HOOK_MARKER}`;
}

function isOurHook(hook) {
  return Boolean(hook) && typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER);
}

function stripOurHooks(groups) {
  return groups
    .map((group) => {
      if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
        fail('a settings hook group has a non-array "hooks" field');
      }
      return { ...group, hooks: (group.hooks || []).filter((hook) => !isOurHook(hook)) };
    })
    .filter((group) => (group.hooks || []).length > 0);
}

function installHooks(root) {
  const settings = loadSettings(root);
  settings.hooks = settings.hooks || {};
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) {
      fail(`${event} in ${settingsPath(root)} must be an array`);
    }
    const groups = settings.hooks[event] || [];
    const cleaned = stripOurHooks(groups);
    cleaned.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }],
    });
    settings.hooks[event] = cleaned;
  }
  writeSettings(root, settings);
  return settings;
}

function removeHooks(root) {
  const settings = loadSettings(root);
  if (!settings.hooks) return settings;
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) {
      fail(`${event} in ${settingsPath(root)} must be an array`);
    }
    if (!Array.isArray(settings.hooks[event])) continue;
    const cleaned = stripOurHooks(settings.hooks[event]);
    if (cleaned.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = cleaned;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(root, settings);
  return settings;
}

function hooksStatus(root) {
  const settings = loadSettings(root);
  return HOOK_EVENTS.filter((event) =>
    (settings.hooks?.[event] || []).some((group) =>
      (group.hooks || []).some((hook) => isOurHook(hook)),
    ),
  );
}

function hooksStale(root) {
  const settings = loadSettings(root);
  const current = hookCommand();
  return HOOK_EVENTS.some((event) =>
    (settings.hooks?.[event] || []).some((group) =>
      (group.hooks || []).some((hook) => isOurHook(hook) && hook.command !== current),
    ),
  );
}

function summarize(state, root) {
  const gates = Object.entries(state.gates || {})
    .map(([id, gate]) => `${id} ${gate.status}${gate.slice ? ` (${gate.slice})` : ''}`)
    .join(' | ');
  const lines = [];
  const label = state.feature ? `${state.mode} (${state.feature.slug})` : state.mode;
  lines.push(`mode: ${label}`);
  lines.push(`stage: ${state.stage}  status: ${state.status}`);
  lines.push(`gates: ${gates}`);
  if (root) {
    const warnings = gateWarnings(root, state);
    lines.push(`evidence: ${warnings.length ? warnings.join('; ') : 'ok'}`);
  }
  if (state.current_slice) lines.push(`slice: ${state.current_slice}`);
  if (state.paused) {
    lines.push(
      `paused: milestone ${state.paused.milestone}, slice ${state.paused.current_slice || 'none'}`,
    );
  }
  if (state.in_flight) {
    const step = state.in_flight.step ? ` ${state.in_flight.step}` : '';
    const roles = state.in_flight.roles || [state.in_flight.role].filter(Boolean);
    const handoffs = state.in_flight.handoffs
      || (state.in_flight.handoff ? [state.in_flight.handoff] : []);
    lines.push(
      `in_flight: ${roles.join(', ')}${step} started ${state.in_flight.started_at}`,
    );
    lines.push(
      `recover: check ${handoffs.length ? handoffs.join(', ') : 'the handoff'} if complete, else re-dispatch ${roles.join(', ')}`,
    );
  }
  lines.push(`next: ${state.next_action || '-'}`);
  return lines.join('\n');
}

function usage() {
  const text = [
    'usage:',
    '  state.js status [--json]',
    '  state.js init --mode <greenfield|feature> [--project <name>] [--slug <slug>]',
    '                  [--base-branch <branch>] [--base-commit <sha>] [--spec <path>]',
    '  state.js set key=value [key=value ...]',
    '  state.js slice <id> key=value [key=value ...]',
    '  state.js slices import <file>',
    '  state.js milestone <n> <pending|in-progress|complete>',
    '  state.js goto <stage> [--no-guard]',
    '  state.js gate <G1..G6> <pending|approved|n/a|inherited> [--evidence <path-or-url>] [--slice <slice-id>]',
    '  state.js verify',
    '  state.js restore [<checkpoint-file>]',
    '  state.js begin --role <role> [--roles <a,b>] [--step <step>] [--handoff <path>] [--handoffs <a,b>]',
    '  state.js end [--next "<next action>"]',
    '  state.js checkpoint [--auto]',
    '  state.js finish-feature',
    '  state.js hooks <install|remove|status>',
    '  state.js selftest',
  ].join('\n');
  console.error(text);
  process.exit(2);
}

function dispatch(argv) {
  const { args, opts } = parseArgs(argv);
  const command = args.shift();
  const root = projectRoot();

  switch (command) {
    case 'status': {
      const state = readState(root, { required: false });
      if (!state) {
        console.log(opts.json ? 'null' : 'no state');
        return;
      }
      console.log(opts.json ? JSON.stringify(state, null, 2) : summarize(state, root));
      return;
    }
    case 'init': {
      console.log(summarize(initState(root, opts), root));
      return;
    }
    case 'set': {
      console.log(summarize(setState(root, args), root));
      return;
    }
    case 'slice': {
      const id = args.shift();
      console.log(summarize(updateSlice(root, id, args), root));
      return;
    }
    case 'slices': {
      const action = args.shift();
      if (action !== 'import') usage();
      console.log(summarize(importSlices(root, args[0]), root));
      return;
    }
    case 'milestone': {
      console.log(summarize(milestoneState(root, args), root));
      return;
    }
    case 'goto': {
      console.log(summarize(gotoState(root, args[0], { guard: opts['no-guard'] !== true }), root));
      return;
    }
    case 'gate': {
      console.log(summarize(gateState(root, args, opts), root));
      return;
    }
    case 'verify': {
      const warnings = verifyGates(root);
      if (warnings.length) {
        console.log(warnings.join('\n'));
        process.exitCode = 1;
      } else {
        console.log('gate evidence ok');
      }
      return;
    }
    case 'restore': {
      console.log(summarize(restoreState(root, args[0]), root));
      return;
    }
    case 'begin': {
      console.log(summarize(beginState(root, opts), root));
      return;
    }
    case 'end': {
      console.log(summarize(endState(root, opts), root));
      return;
    }
    case 'checkpoint': {
      if (opts.auto) {
        const state = readState(root, { required: false });
        if (state) checkpoint(root, state, 'auto');
        return;
      }
      console.log(checkpointState(root));
      return;
    }
    case 'finish-feature': {
      console.log(summarize(finishFeatureState(root), root));
      return;
    }
    case 'hooks': {
      const action = args[0];
      if (action === 'install') {
        installHooks(root);
        console.log(`installed state snapshot hooks in ${settingsPath(root)}`);
      } else if (action === 'remove') {
        removeHooks(root);
        console.log(`removed state snapshot hooks from ${settingsPath(root)}`);
      } else if (action === 'status') {
        const active = hooksStatus(root);
        const stale = active.length > 0 && hooksStale(root);
        if (active.length) {
          console.log(
            `state hooks active: ${active.join(', ')}${stale ? ' (stale path; run hooks install)' : ''}`,
          );
        } else {
          console.log('state hooks not installed');
        }
      } else {
        usage();
      }
      return;
    }
    case 'selftest': {
      const testers = fs
        .readdirSync(__dirname)
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => path.join(__dirname, name));
      const result = spawnSync(process.execPath, ['--test', ...testers], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
      return;
    }
    default:
      usage();
  }
}

function main() {
  try {
    dispatch(process.argv.slice(2));
  } catch (error) {
    if (error instanceof StateError) {
      console.error(`ecc-workflow state: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (require.main === module) main();

module.exports = {
  VERSION,
  StateError,
  projectRoot,
  stateDir,
  statePath,
  checkpointDir,
  archiveDir,
  settingsPath,
  readState,
  writeState,
  checkpoint,
  initState,
  setState,
  updateSlice,
  importSlices,
  milestoneState,
  gotoState,
  gateState,
  verifyGates,
  restoreState,
  beginState,
  endState,
  checkpointState,
  finishFeatureState,
  installHooks,
  removeHooks,
  hooksStatus,
  hooksStale,
  isOurHook,
  summarize,
  parseArgs,
  safeSlug,
  shellQuote,
  writeFileAtomic,
};
