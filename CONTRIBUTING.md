# Contributing to ecc-workflow

Thanks for wanting to improve the workflow. This repository is a **Claude Code skill**, not an application: the product is `SKILL.md` plus the procedures and scripts that carry out its stages. A change is good when a real project run gets clearer, safer, or shorter — not when the skill gets bigger.

## Ground rules

1. **The orchestrator stays small.** `SKILL.md` is loaded into the main session's context on every run. Prefer moving detail into `references/` or `assets/` and linking to it, over growing `SKILL.md`.
2. **Stage procedures load one at a time.** `references/stages.md` is read with a `sed` range per stage. Keep every stage a self-contained `## Stage N:` section so that stays true.
3. **Gates are human-only.** Nothing in a skill change may let a subagent approve a gate, edit `state.json`, or run a git/`gh` write. Those boundaries are the product.
4. **State writes go through `assets/state.js`.** New state fields need a `set`/`gate`/`begin`/`end` path, a checkpoint, and a test.
5. **No secrets, no absolute personal paths.** Examples use placeholders such as `<owner>/<name>` and `<skill-dir>`.

## Development setup

Clone anywhere and link it into your skills directory:

```bash
git clone https://github.com/eliozh/ecc-workflow.git
ln -s "$PWD/ecc-workflow" ~/.claude/skills/ecc-workflow
```

Start a new Claude Code session after changing `SKILL.md` or its frontmatter.

## Test before you open a PR

The suite is `node:test` with no dependencies:

```bash
node --test assets/*.test.js
node assets/state.js selftest
bash -n assets/bootstrap.sh
bash -n assets/guard.sh
```

All 25 tests must pass. CI runs the same commands on every push and pull request to `main`.

If you change behavior that a stage relies on, also update the matching section of `references/stages.md`, and `SKILL.md` if it states the rule.

## Repository map

| Path | What belongs there |
|---|---|
| `SKILL.md` | Orchestrator rules, mode table, state schema, gate table, stage map |
| `references/stages.md` | One section per stage: numbered steps, executors, handoffs |
| `references/subagents.md` | Brief template, standard do-not list, 18 role contracts |
| `assets/state.js` | The only writer of `state.json`; checkpoints, `in_flight`, hooks |
| `assets/guard.sh` | Install/remove the two pre-approval Hookify rules |
| `assets/bootstrap.sh` | Stage 0: repo, ignore file, guard, local state dir |
| `assets/*.test.js` | The test suite |
| `assets/ci.yml`, `dependabot.yml`, `pull_request_template.md` | Templates copied into generated projects |
| `WORKFLOW.md`, `WORKFLOW.zh-CN.md` | Human-readable process documentation |
| `docs/skill-reference.md` | Deeper operational reference for users |

## Commit style

Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. One logical change per commit. If a change touches both a stage procedure and its script, keep them in one commit so they cannot drift.

## Pull requests

- Say which stage or role the change affects, and what goes wrong today.
- Include the test output.
- If the change alters a gate, a state field, or a subagent's permissions, call it out explicitly in the description — those are the parts reviewers read most carefully.
- Keep unrelated refactors out. Small, reviewable diffs win.
