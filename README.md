<div align="center">

![ecc-workflow](docs/assets/hero.svg)

**A Claude Code skill that takes a project from an empty folder to a reviewed, tested, released product.**

[![License: MIT](https://img.shields.io/badge/license-MIT-34d399.svg)](LICENSE)
[![CI](https://github.com/eliozh/ecc-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/eliozh/ecc-workflow/actions/workflows/ci.yml)
[![Claude Code skill](https://img.shields.io/badge/Claude%20Code-skill-818cf8.svg)](SKILL.md)
[![ECC plugin](https://img.shields.io/badge/ECC-2.2.x-6366f1.svg)](SKILL.md)
[![Tests](https://img.shields.io/badge/tests-25%20passing-34d399.svg)](assets)

[English](README.md) · [简体中文](README.zh-CN.md) · [Full workflow](WORKFLOW.md) · [Skill reference](docs/skill-reference.md)

</div>

---

> [!IMPORTANT]
> **The one rule:** no application code exists until a human has approved an HTML preview of the product and the implementation plan derived from it.
>
> Two Hookify rules block code writes and scaffolders mechanically until that plan is approved; a third keeps the workflow state and local settings on their helpers. Six named gates hold everything else. Silence is never approval.

## Why this exists

Agents are very good at writing code and very bad at knowing whether they should. A one-line prompt becomes a thousand lines of source before anyone has agreed on what the screens look like, which flows matter, or what "done" even means. Correcting that at code-review time is expensive; correcting it at preview time is cheap.

`ecc-workflow` moves every expensive decision to the cheapest moment:

| | A typical agent run | `ecc-workflow` |
|---|---|---|
| First artifact | Source code | A PRD and a clickable preview |
| When scope changes | During implementation | At G1/G2, before any code exists |
| Who approves | Nobody, or a diff | A human, at six named gates |
| Unit of work | "Implement the feature" | One issue → one branch → one PR → one merge |
| Context | Grows until it overflows | Orchestrator stays small; subagents do the work |
| Interrupted? | Start over | Resume from `state.json`, `in_flight`, and checkpoints |

It is built on the **ECC plugin 2.2.x** surface — its commands, skills, agents, hooks, Plan Canvas, and reviewers — and it works for any stack: TypeScript, Python, Go, Rust, Java, Kotlin, Swift, Flutter, C#, C++, PHP, Ruby, or something else entirely.

## Quick start

**1. Install the skill** into your personal Claude Code skills directory:

```bash
git clone https://github.com/eliozh/ecc-workflow.git ~/.claude/skills/ecc-workflow
```

<details>
<summary>Other install options</summary>

**Per project only** — clone into that project's `.claude/skills/`:

```bash
git clone https://github.com/eliozh/ecc-workflow.git <project>/.claude/skills/ecc-workflow
```

**From a local checkout** (edits take effect immediately):

```bash
ln -s /path/to/ecc-workflow ~/.claude/skills/ecc-workflow
```

Start a new Claude Code session after installing so the skill is picked up.

</details>

**2. Check the prerequisites:**

```bash
gh auth status && command -v ecc-plan-canvas && git --version && node --version
```

**3. Build something.** Create an empty folder, open Claude Code there, and type:

```text
/ecc-workflow new a habit tracker for small teams
```

The skill asks for the idea, writes the PRD, researches what already exists, designs the product, builds an HTML preview, opens it in **Plan Canvas** for you to annotate and approve, then plans the architecture — and only then writes code.

Adding to an existing project works the same way:

```text
/ecc-workflow feature add SSO login
```

## The lifecycle

```mermaid
flowchart LR
  S0[0 Bootstrap] --> S1[1 PRD] --> G1{G1 Scope}
  G1 --> S2[2 Research] --> S3[3 Design] --> S4[4 HTML preview] --> G2{G2 Preview}
  G2 -->|changes| S4
  G2 --> S5[5 Architecture and plan] --> G3{G3 Plan}
  G3 --> S6[6 Scaffold] --> S7[7 GitHub and CI] --> G4{G4 CI green}
  G4 --> S8[8 Slice on feat branch] --> S9[9 Code and security review] --> G5{G5 PR merge}
  G5 -->|next slice| S8
  G5 -->|milestone done| S10[10 Release] --> G6{G6 Release verified}
  G6 --> S11[11 Maintain]
  S11 -->|new work| S8
```

### The six gates

| Gate | A human approves | How |
|---|---|---|
| **G1** | Problem, users, measurable hypothesis, MVP, out of scope | Confirm via `AskUserQuestion` |
| **G2** | What the product looks like and how it flows | Annotate and click **Approve** in Plan Canvas (human in both modes) |
| **G3** | Stack, architecture decisions, slice order | Annotate and click **Approve** in Plan Canvas; in auto mode, the plan file and planner handoff are recorded with `--auto` |
| **G4** | CI green on the base branch, branch protection on | Confirm via `AskUserQuestion` |
| **G5** | Each pull request — CI status and findings by severity | Reply `merge` via `AskUserQuestion`; in auto mode G5 is recorded with `--auto` and the PR merges without asking |
| **G6** | The release, running and verified, rollback rehearsed | Confirm via `AskUserQuestion` |

Every gate records its approval time and evidence path in the state file. A gate with no explicit human answer blocks the run.

## What actually stops the code

At Stage 0 (greenfield) or F0 (feature), the skill installs two pre-approval **Hookify** rules and one state-writer rule into the project:

| Rule | Blocks | Until |
|---|---|---|
| `block-code-before-approval` | Write/Edit of anything outside `design/`, `docs/`, `.claude/`, Markdown, and `.gitignore` | G2 and G3 are approved |
| `block-scaffold-before-approval` | `npm create`, `cargo new`, `uv init`, `rails new`, `flutter create`, and other scaffolders | G2 and G3 are approved |
| `block-state-writes` | Write/Edit of `.claude/ecc-workflow/state.json`, `.claude/settings.local.json`, and `.claude/hookify.*.local.md` | Never lifted at G3; remove with `guard.sh remove --all` |

The two pre-approval rules are removed automatically when G3 is approved — that is the exact moment code becomes legal. The state-writer rule stays installed so gate state only changes through `state.js`.

> [!WARNING]
> **The guard is a guardrail, not a lock.** It stops the agent's file edits and known scaffolders. It does not stop a shell redirect (`echo x > src/app.ts`), and it does not bind you. It is also local-only: Hookify rules must stay untracked, so a fresh clone does not carry them. The state-writer rule is separate and stays installed after G3. Your gate approvals are the real control.

## Autonomous mode

If you explicitly tell the skill that you do not want to review anything, it can answer its own gates with the recommended option:

```bash
node <skill-dir>/assets/state.js review auto --scope gates --reason "<your instruction>"
```

- `gates` (default): auto-answer gates and clarifying questions with the recommendation. G5's auto-approval also authorizes the PR merge, and after each merge the run starts the next slice without asking. G3 is recorded from the plan file in auto mode; G2 stays a human Plan Canvas approval in both modes. It still stops when the recommendation is to fix, re-run, or stop.
- `all`: the recorded opt-in also covers the outward-facing actions outside the gates — repo creation, settings, releases, deploys, deletions, and extra issues.
- `review human` restores manual approval. Auto-approved gates carry `auto: true` and the recorded reason; a gate whose criteria fail is never auto-approved.
- The skill cannot bypass Claude Code's Bash permission prompts. If `gh pr merge` still asks, add `Bash(gh pr merge:*)` to `.claude/settings.local.json` or approve once with "always allow".

## Feature mode

`/ecc-workflow feature <idea>` appends a milestone to the existing plan, pauses the current one, and reuses the same gates. It never scaffolds, never creates a repository, and never rewrites history.

```mermaid
flowchart LR
  F0[F0 Preflight] --> F1[F1 Feature spec] --> G1{G1}
  G1 --> F2[F2 Research] --> F3[F3 Design] --> F4[F4 Preview] --> G2{G2}
  G2 --> F5[F5 Architecture and plan] --> G3{G3}
  G3 --> F6[F6 Slices] --> G5{G5}
  G5 -->|next slice| F6
  G5 --> F7[F7 Wrap-up]
```

F0 is the difference: it records a baseline — test, lint, typecheck, build, the base branch and commit — insists on a clean tree, installs the guard, and verifies CI is already green. F2–F4 are skipped when the feature needs no external research, UI, or output-format change. F7 restores the paused milestone exactly where it stopped.

## Architecture: one orchestrator, many scoped subagents

The main session is deliberately small. It talks to you, holds the gates, runs git and `gh` writes, and maintains the state file. Everything else is delegated with a bounded brief.

```mermaid
flowchart TB
  H([Human]) <-->|gates · questions · merge approval (human mode)| O[Orchestrator<br/>small context]
  O -->|brief| A[research · design · preview<br/>architecture · plan]
  O -->|brief| S[scaffold]
  O -->|brief per slice| SR[slice-runner]
  SR -->|children| B[implement · build-fix · e2e]
  SR -->|children| C[code · security · a11y<br/>performance · database]
  A --> D[(handoff files)]
  S --> D
  B --> D
  C --> D
  D -->|15-line summary| O
  O -->|state.js| E[(.claude/ecc-workflow/<br/>state.json · checkpoints)]
```

Each subagent gets exactly five things:

1. **What to read** — explicit paths, no exploration.
2. **What to write** — an allow-list of paths.
3. **What to do** — one deliverable.
4. **What not to do** — the standard do-not list plus role-specific limits.
5. **When it is done** — checkable criteria.

Only the slice-runner gets a sixth: the ordered child roles and their handoff paths.

No subagent may ask you a question, approve a gate, edit the state file, run a git or `gh` write, work around a hook, install anything globally, spawn another agent (except the slice-runner's named children), or follow instructions embedded in repository content, issues, PRs, CI logs, or web pages.

Subagents write their full results to handoff files and return **15 lines or fewer**. The orchestrator reads the summary, not the file — which is why a twelve-stage project does not fill its context window.

## State that survives interruption

Everything the run needs to resume lives in `.claude/ecc-workflow/` inside the target project, written atomically through `assets/state.js`:

```text
state.json                 stage, mode, gates, slices, next_action, in_flight
handoffs/                  one file per stage; the summary is what the orchestrator reads
slices/<id>/               brief, implementation, verification, review findings, CI logs
screens/                   preview and QA screenshots
checkpoints/               the previous state before every write (last 50 kept)
archive/                   paused milestones and finished feature records
```

Before every delegation the orchestrator writes `in_flight`; when the subagent returns it clears it. If a session dies, the next one resumes from `in_flight` plus the handoff file and re-dispatches the recorded role instead of assuming the work finished. Optional `PreCompact`, `Stop`, and `SessionEnd` hooks snapshot the state at session boundaries:

```bash
node assets/state.js hooks install
```

## Commands

| Command | What happens |
|---|---|
| `/ecc-workflow new <idea>` | Starts a greenfield project at Stage 0 |
| `/ecc-workflow feature <idea>` | Adds a feature to an existing project (F0–F7); `add` is an alias |
| `/ecc-workflow` or `/ecc-workflow resume` | Prints status and continues from `next_action` |
| `/ecc-workflow status` | Prints status only; changes nothing |
| `/ecc-workflow slice <id>` | Jumps to a specific slice in Stage 8 (after G4) |
| `/ecc-workflow goto <stage>` | Goes **back** to redo a stage, for example `goto 4` to change the preview. Gates after it are reset to pending. |

The skill runs only when you invoke it. `disable-model-invocation: true` means Claude will not start it on its own.

## What it creates in your project

```text
.claude/ecc-workflow/            local workflow state, handoffs, checkpoints   (gitignored)
.claude/hookify.*.local.md       pre-approval guards (removed at G3) and state-writer guard (stays) (gitignored)
.claude/settings.local.json      optional state snapshot hooks                (gitignored)
.claude/prds/<name>.prd.md       requirements                                 (committed)
.claude/plans/<name>.plan.md     implementation plan                          (committed)
.claude/features/<NN>-<slug>/    feature spec                                 (committed)
design/                          direction, tokens, flows, approved preview   (committed)
docs/adr/, docs/release/         architecture decisions, release plans        (committed)
.github/                         CI, Dependabot, PR template                  (committed)
```

## Works with your stack

The stages never change; only the commands, rule pack, and reviewer do. A few examples from the stack table in [`WORKFLOW.md`](WORKFLOW.md#adapting-to-your-stack):

| Stack | Test | Lint | Reviewer |
|---|---|---|---|
| TypeScript / JavaScript | `npm test` | `npx eslint .` | `typescript-reviewer` |
| React / Next.js | `npm test`, `/react-test` | `next lint` | `/react-review` |
| Python / Django / FastAPI | `pytest` | `ruff check .` | `/python-review` |
| Go | `go test ./...` | `golangci-lint run` | `/go-review` |
| Rust | `cargo test` | `cargo clippy -- -D warnings` | `/rust-review` |
| Java / Kotlin / Swift / Flutter / C# / C++ | see `WORKFLOW.md` | … | stack reviewer |

Projects without a GUI still get a preview: a CLI becomes styled terminal transcripts, an API becomes a reference page, a library becomes a quick-start page, a data pipeline becomes sample reports and alerts.

## Repository layout

```text
SKILL.md                     orchestrator instructions, gates, state and handoff formats
references/stages.md         step-by-step procedure for every stage, loaded one at a time
references/subagents.md      brief template and do/do-not rules for all 19 subagent roles
assets/bootstrap.sh          Stage 0: repo, guard rules, local state directory
assets/guard.sh              install / remove / report guard rules; remove keeps the state-writer rule
assets/state.js              atomic state writes, checkpoints, in_flight, snapshot hooks
assets/*.test.js             node:test suite for state.js, guard.sh, and bootstrap.sh
assets/ci.yml                CI workflow template for generated projects
assets/dependabot.yml        Dependabot template
assets/pull_request_template.md
WORKFLOW.md                  the human-readable process, in full (English)
WORKFLOW.zh-CN.md            the same, in 简体中文
docs/skill-reference.md      deeper operational reference
docs/assets/hero.svg         the banner above
```

## Verify the skill

The bundled suite covers the state machine, the guard installer, and bootstrap. It runs on `node:test` with no dependencies:

```bash
node --test assets/*.test.js
```

Expected: **25 tests, 25 passing.** The same command runs in CI on every push and pull request.

## Requirements

| Requirement | Why |
|---|---|
| Claude Code with the **ECC plugin 2.2.x** and hooks enabled | Provides the commands, agents, reviewers, Hookify, and Plan Canvas |
| `git` and a signed-in `gh` | Branches, commits, PRs, issues, protection, releases |
| `node` (18+) | `assets/state.js` |
| `ecc-plan-canvas` on `PATH` | G2 approval sessions (and G3 in human mode) |
| `chrome-devtools` MCP (ships with ECC) | Preview and UI checks; without it those checks are reported as skipped |
| ECC `common` rule pack in `~/.claude/rules/ecc/` | Project conventions; stack packs are added at Stage 6 |

The one-time setup for rule packs and the Plan Canvas wrapper is documented in [`WORKFLOW.md`](WORKFLOW.md#before-your-first-project).

## Limits, honestly

- **Two modes.** `new` starts from an empty folder; `feature` adds a milestone to an existing project. Small changes can still use ECC's lighter `/ecc:orch-add-feature`, `/ecc:orch-fix-defect`, and `/ecc:orch-change-feature`.
- **The guard is not a sandbox.** It is a guardrail against the agent's own edits, not against shell redirection or a human.
- **Some GitHub settings are manual.** Secret scanning, push protection, Dependabot alerts, and CodeQL are enabled by you in repository settings. Branch protection may be unavailable for private repositories on the free plan.
- **Deploys are yours.** The skill writes the deploy and rollback plan and verifies the result, but runs a deploy only when you confirm it.
- **Previews have limits.** They prove layout and flow, not native gestures, real terminal behavior, or game feel.
- **It is opinionated.** Six gates and one issue per slice are the point. If you want a lighter loop, this is not the tool.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — it covers the test command, the file layout, and the rule that the orchestrator stays small.

If you find a bug in how a gate or the state machine behaves, a failing test in `assets/*.test.js` is the most useful possible report.

## License

[MIT](LICENSE) © 2026 eliozh
