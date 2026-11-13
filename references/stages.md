# Stage procedures

Load one section at a time with the `awk` command in `SKILL.md` → Startup step 6.

`H` below means `.claude/ecc-workflow/handoffs`, and `S` means `.claude/ecc-workflow/slices/<slice-id>`. `<base-branch>` means `state.base_branch` (`master` for a greenfield project unless the human chose another name). Every subagent is briefed per `references/subagents.md`. Update state through `assets/state.js` after each numbered step.

Three sequences share this file:

- **Greenfield:** Stages 0–11.
- **Feature:** Stages F0–F7, then back to the paused milestone.
- **Shared:** 2, 3, 4, 5, 8, 9, and 10 are reused by feature mode; their procedures are unchanged unless an F-stage section says otherwise. Commands use `<base-branch>`, which resolves to `state.base_branch`.
- **Autonomous mode:** when `state.review_mode` is `auto`, replace every “ask the human” and “explicit yes” with the recommended option, except G2, and record the gate with `--auto`. If the recommendation is to stop, fix first, re-run, or escalate, take that path instead of approving. G5's auto-approval also authorizes the merge. G3 is recorded from the plan file and planner handoff; G2 stays a human canvas verdict. `review_scope=all` covers the outward confirmations outside the gates; the default `gates` scope does not. After each merge, continue to the next slice without asking.
- **Switching modes:** re-read `review_mode` and `review_scope` from state before every gate and every loop iteration; never cache them. A switch to `human` takes effect at the next gate or slice boundary, and a running subagent finishes first. Re-read both immediately before an outward action (merge, tag, release, deploy); if either no longer covers it, ask. If `gate ... --auto` fails because the mode changed, ask the human instead of forcing it.
- **Asking:** when a step says “ask the human”, ask with the `AskUserQuestion` tool, recommended option first and labeled `(Recommended)`. G2 stays in Plan Canvas; in auto mode G3 is recorded from the plan file. Free-form answers such as a repository name, version, or URL stay in plain chat.

## Stage 0: Bootstrap

Executor: orchestrator.

1. Confirm the folder is empty except dotfiles, and that its absolute path contains no `/docs/` or `/design/` segment. Either one makes the guard exempt every file; if so, stop and ask the human to move the project.
2. Run the bootstrap script from the project root:

```bash
bash <skill-dir>/assets/bootstrap.sh
```

3. Write the initial state through the helper:

```bash
node <skill-dir>/assets/state.js init --mode greenfield --project <name> --base-branch "$(git branch --show-current)"
```

   Also ask whether to install the optional state snapshot hooks. On yes, run `node <skill-dir>/assets/state.js hooks install`; `bootstrap.sh` already gitignores `.claude/settings.local.json`.
4. Confirm all three rules are active with `/ecc:hookify-list`. If hooks are off, stop and tell the human how to enable them.

Exit: all three guard rules listed, one commit on the base branch (`master` by default).

## Stage 1: PRD

Executor: orchestrator. This stage questions the human, so it can't be delegated.

1. Run `/ecc:plan-prd <idea>` and answer its gates with the human. Use `/ecc:prp-prd` instead only if the human asks for deeper discovery.
2. Optionally, if the human wants it: `ecc:product-lens` to pressure-test the idea, or `ecc:council` for a contested scope call.
3. Record `prd` in state.

**G1:** show problem, primary user, hypothesis with measurable outcome, MVP, and out-of-scope list in 10 lines or fewer. On an explicit yes: commit `docs: add PRD`, then:

```bash
node <skill-dir>/assets/state.js gate G1 approved --evidence .claude/prds/<name>.prd.md
```

## Stage 2: Research

1. Dispatch **researcher**. READ: the PRD. HANDOFF: `H/02-research.md`.
2. Read the summary. For each question it marked `needs-human`, ask the human and record the answer in the handoff's `## Needs human` section.

Exit: every PRD open question is answered or deferred with an owner. Trivial projects may skip this stage only if the human says so; record that in state.

## Stage 3: UX and design system

Skip the visual direction for projects with no GUI, but still write `design/flows.md` (for a CLI, the commands; for an API, the call sequences) and a short `DESIGN.md` covering voice, error-message style, and output formatting.

1. Dispatch **designer**. READ: PRD, `H/02-research.md`. HANDOFF: `H/03-design.md`.
2. Then dispatch **a11y-designer** (GUI projects). READ: `design/DESIGN.md`, `design/design-tokens.json`. HANDOFF: `H/03-a11y.md`.
3. If the a11y handoff reports failing token pairs, re-dispatch designer once with that list.
4. Commit `docs: add design direction and tokens`.

Exit: `design/DESIGN.md`, `design/design-tokens.json`, `design/flows.md` exist.

## Stage 4: HTML preview

1. Dispatch **preview-builder**. READ: PRD, `design/DESIGN.md`, `design/design-tokens.json`, `design/flows.md`. HANDOFF: `H/04-preview.md`. Put the project type's form from this table in the brief:

| Project type | Preview shows |
|---|---|
| Web app or site | The real screens at target breakpoints |
| Mobile | Screens in device frames, per platform where they differ |
| Desktop | Windows, menus, dialogs |
| CLI or TUI | Styled terminal transcripts: `--help`, success, failure, exit codes |
| API | Reference page: example requests and responses, error catalog, auth flow |
| Library or SDK | Quick start, usage examples, error messages |
| Data or ML pipeline | Sample reports, dashboards, alerts, input and output shapes |
| Game | Screen flow, HUD layouts, menus |

2. Dispatch **preview-checker**. HANDOFF: `H/04-preview-check.md`.
3. If it reports CRITICAL or HIGH findings, re-dispatch preview-builder with the findings table, then re-check. Two rounds at most, then show the remaining findings to the human.
4. Open the review and listen in the background (Bash with `run_in_background: true`):

```bash
ecc-plan-canvas open design/preview/index.html
ecc-plan-canvas await design/preview/index.html
```

5. Feedback loop. When `await` returns:
   - Save the JSON to `H/04-feedback-<k>.json`.
   - `chat` items: answer with `--reply`.
   - `annotation` items: reply "On it", dispatch preview-builder with the feedback file, then reply with what changed (from its handoff summary). The canvas live-reloads.
   - If feedback changes scope, update the PRD first (orchestrator, with the human), then the flows, then the preview.
   - Re-run `await` in the background after every reply.
6. **G2:** the verdict `approve`. Then:

```bash
ecc-plan-canvas end design/preview/index.html
git add design && git commit -m "docs: approve HTML preview"
node <skill-dir>/assets/state.js gate G2 approved --evidence design/preview/index.html
```

   **G2 is human in both modes.** Even when `review_mode=auto`, do not record G2 with `--auto`; open the canvas and wait for the human's `approve`. This is the one gate auto mode does not answer.

## Stage 5: Architecture and plan

1. Dispatch **architect**. READ: PRD, `H/02-research.md`, `design/DESIGN.md`, `design/flows.md`, `design/preview/index.html`. HANDOFF: `H/05-architecture.md`.
2. Show the human the options and recommendation (from the summary) and ask them to choose the stack. Record `stack` in state, using an id from the stack table in `WORKFLOW.md` when one fits.
3. Dispatch **planner** for `state.milestone`. READ: PRD, the ADRs, `H/05-architecture.md`, `design/flows.md`. HANDOFF: `H/05-plan.md`. Then record the plan: `node <skill-dir>/assets/state.js set plan=.claude/plans/<name>.plan.md`.
4. Copy the slice list from the plan into `state.slices`. Prefer writing the list as JSON and importing it, so slices are matched by id instead of position:

```bash
node <skill-dir>/assets/state.js slices import <file>
```

   The JSON must include `milestone: <state.milestone>` on every slice. The importer appends new ids, preserves an existing slice's `status`, `branch`, `issue`, and `pr`, and rejects duplicate ids.
5. **G3:** in human mode, run the same Plan Canvas loop as Stage 4 on `.claude/plans/<name>.plan.md`, dispatching planner (or architect, for ADR changes) to apply feedback. On `approve`:

```bash
ecc-plan-canvas end .claude/plans/<name>.plan.md
bash <skill-dir>/assets/guard.sh remove
node <skill-dir>/assets/state.js gate G3 approved --evidence .claude/plans/<name>.plan.md
```

   In auto mode, do not open or await the canvas. Check that `H/05-plan.md` is `Status: done`, the plan file exists, the slice list is imported, and no open question remains; then remove the guard and record the gate from the plan file:

```bash
bash <skill-dir>/assets/guard.sh remove
node <skill-dir>/assets/state.js gate G3 approved --evidence .claude/plans/<name>.plan.md --auto
```

   `guard.sh remove` deletes the two pre-approval rules; the state-writer rule stays installed. G2 is not part of this shortcut: it stays a human canvas verdict in both modes.

6. After G3 is recorded (canvas `approve` in human mode, plan-file check in auto mode), make sure the approved slice list is in `state.slices` (the import in step 4 does this). **Do not create issues here for a greenfield project:** the remote does not exist until Stage 7. Stage 7 step 6 creates the issue batch after `gh repo create`, and the G3 approval authorizes it. When this stage runs for a later milestone, the repository already exists, so create one issue per slice whose `milestone` equals `state.milestone` here after G3. In both cases, never duplicate an issue that a slice already has, and record each number with:

```bash
node <skill-dir>/assets/state.js slice <slice-id> issue=<n>
```
7. Have the architect's ADRs flipped from `proposed` to `accepted` (trivial edit, orchestrator), then commit `docs: approve architecture and implementation plan`.

## Stage 6: Scaffold

1. Dispatch **scaffolder**. READ: ADRs, plan (first slice only), `.env` rules from `.gitignore`. HANDOFF: `H/06-scaffold.md`. The brief says the walking skeleton is the first slice's thinnest end-to-end path, not the full slice.
2. Show the human the `/ecc:project-init` dry-run summary. On approval, run the apply command it printed.
3. Ask the human whether to copy the stack's rule pack into `~/.claude/rules/ecc/` (it's a global change). Copy only on yes.
4. Run the test command yourself once. Then run `/ecc:harness-audit` and pass anything CRITICAL to the scaffolder.
5. Commit `chore: scaffold project`, then `feat: add walking skeleton` if the skeleton was a separate step.

Exit: build and tests pass locally.

## Stage 7: GitHub and CI

1. Dispatch **ci-author**. READ: `CLAUDE.md`, `<skill-dir>/assets/ci.yml`, `<skill-dir>/assets/dependabot.yml`, `<skill-dir>/assets/pull_request_template.md`. HANDOFF: `H/07-ci.md`. Commit `ci: add CI, Dependabot, and PR template`.
2. Ask for the repo name and visibility. On confirmation, create it with exactly one visibility flag:

```bash
gh repo create <name> --private --source=. --push   # private
gh repo create <name> --public  --source=. --push   # public
node <skill-dir>/assets/state.js set repo=<owner>/<name>
```

3. Watch CI (background). If it fails, follow the CI-failure rule in `SKILL.md`.

```bash
gh run watch --exit-status
```

4. Ask to enable branch protection. On confirmation, apply it, using a review count of `0` when solo:

```bash
gh api -X PUT repos/<owner>/<name>/branches/<base-branch>/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
EOF
```

   If the plan doesn't support it (private repo on the free plan), tell the human and record `protection: "convention"` in state.
5. Read it back, without test-pushing to `<base-branch>`:

```bash
gh api repos/<owner>/<name>/branches/<base-branch>/protection --jq '.required_status_checks.contexts'
```

6. This is where a greenfield project creates its issue batch, after the remote exists. For every slice in the approved plan, create exactly one issue titled `[<slice-id>] <title>`, skipping any slice that already has one. Each body names the milestone, the plan path and §4 of the plan, whether a security review is required, and the done-when: the slice's acceptance criteria pass in CI `verify` and the PR body contains `Closes #<issue>`. The G3 approval already authorized this batch; do not ask again. Record each number with `node <skill-dir>/assets/state.js slice <slice-id> issue=<n>`. Later milestones, planned when the repository already exists, create their issues at Stage 5 step 6 after G3.
7. Remind the human to enable secret scanning, push protection, Dependabot alerts, and CodeQL under Settings → Code security. These aren't done by the skill.

**G4:** show the green run link and the protection read-back. On yes:

```bash
node <skill-dir>/assets/state.js gate G4 approved --evidence "<CI run URL>"
node <skill-dir>/assets/state.js set stage=8 current_slice=<first-pending-id>
```

## Stage 8: Build, verify, and locally review one slice

Repeat per slice. One slice equals one branch equals one PR. The **slice-runner** does the child work; the orchestrator does every git write and keeps the state.

1. Mark the slice current and branch from an up-to-date `<base-branch>`:

```bash
node <skill-dir>/assets/state.js set current_slice=<slice-id> status=in-progress
node <skill-dir>/assets/state.js slice <slice-id> status=in-progress
node <skill-dir>/assets/state.js gate G5 pending --slice <slice-id>
git switch <base-branch> && git pull --ff-only && git switch -c feat/<slice-id>
```

2. Extract the slice's section of the plan into `S/brief.md`. Add the preview screens it implements and the stack's test command. Select the child roles for this slice and list them in the brief in execution order:
   - always: `implementer`, `verifier`, `build-fixer` (dispatch only if the build breaks)
   - `e2e` when the slice includes a critical journey
   - reviewers: always `ecc:code-reviewer` and the stack reviewer; `ecc:security-reviewer` when `security: true` or the diff touches auth, user input, queries, file paths, external APIs, crypto, payments, or secrets; `ecc:a11y-architect` when `ui: true`; `ecc:performance-optimizer` for hot paths, bundle growth, or slow queries; `ecc:database-reviewer` for schema or query changes
   - `fixer` for the review findings

   Give each child its handoff path under `S/` (`implement.md`, `verify.md`, `e2e.md`, `review-<kind>.md`, `findings.md`, `build-<n>.md`).

3. Dispatch **slice-runner** with `CHILD ROLES` and `CHILD HANDOFFS`. It runs: implementer → build-fixer if the build breaks → verifier and e2e in parallel → reviewers in parallel → fixer for CRITICAL/HIGH/MEDIUM → re-run only the reviewers that raised findings. It writes `S/runner.md` with the verification result, finding counts, deferred LOWs, the proposed Conventional Commit message, and the PR body with `Closes #<issue>`.
4. If it returns `needs-human` because the design must change: run `goto 4` with the human for that screen, re-approve G2, then resume this slice.
5. Read only `S/runner.md`'s `Status` and `## Summary`. Check that the claimed outputs exist and run the test command yourself once. On a failure, re-dispatch the slice-runner with a narrower `CHILD ROLES` list (fixer, verifier, build-fixer if needed, the affected reviewers) at most twice, then escalate.
6. Commit with the message from `S/runner.md`.

Exit: verification passes, local review findings are fixed or explicitly deferred, and the commit is made.

## Stage 9: PR, review, and merge

The slice-runner already ran the local code and security review in Stage 8. Its `S/runner.md` has the finding counts; reuse them instead of re-dispatching the same reviewers.

1. Push and open the PR:

```bash
git push -u origin feat/<slice-id>
```

   Then run `/ecc:pr <base-branch>`. The body must contain `Closes #<issue>` so merging the PR closes the issue; if `state.base_branch` is not the repository default branch, close the issue explicitly after the merge. Include the MEDIUM findings from `S/runner.md` for traceability: MEDIUMs are fixed before merge, so this list records what was fixed plus any accepted or deferred item.

```bash
node <skill-dir>/assets/state.js slice <slice-id> status=in-review
```

2. Watch checks in the background, and handle failures with a build-fixer dispatch (or a narrow slice-runner with `CHILD ROLES: build-fixer`):

```bash
gh pr checks <n> --watch
```

3. PR-level review: `/ecc:orch-review <n>` for security slices, otherwise `/ecc:review-pr <n>`. Save the output to `S/pr-review.md`. Use `/ecc:santa-loop` instead for auth, payments, or migrations if the human wants it.
4. New CRITICAL, HIGH, or MEDIUM findings: dispatch a **fix slice-runner** with `CHILD ROLES: fixer, verifier, build-fixer (if needed), <affected reviewers>`, the findings file, and HANDOFF `S/runner-fix-<n>.md`. At most two rounds, then escalate. Record the fixed and deferred items in that handoff and carry them into the PR body.
5. **G5:** show the PR link, check status, and finding counts by severity.
   - **Human mode:** ask "merge?" with `AskUserQuestion`. On an explicit merge, go to step 6. On anything else, set `status=blocked`, record the reason in `S/findings.md`, and stop.
   - **Auto mode:** do not ask. Go straight to step 6; the G5 auto-approval is the merge authorization.
6. Merge and record the gate:

```bash
gh pr merge <n> --squash --delete-branch
git switch <base-branch> && git pull --ff-only
node <skill-dir>/assets/state.js gate G5 approved --slice <slice-id> --evidence "<PR URL>"   # add --auto in auto mode
```

7. Mark the slice merged and ask the helper what is next:

```bash
node <skill-dir>/assets/state.js slice <slice-id> status=merged
node <skill-dir>/assets/state.js next
```

   It returns `{"action":"start|resume","slice":"<id>","milestone":<n>}`, `{"action":"blocked",...}`, or `{"action":"milestone-done","milestone":<n>}`.
   - `start` (`status: pending`): set `current_slice=<id> status=in-progress`, branch, and run Stage 8.
   - `resume` (`status: in-progress`): continue Stage 8 for that slice.
   - `resume` (`status: in-review`): continue Stage 9 at the PR checks; leave the slice status unchanged.
   - `blocked`: stop and report the slice and status.
   - `milestone-done`: go to step 8.

   In auto mode, act on `start` or `resume` immediately and do not ask whether to continue; in human mode, ask before starting a new slice. Read the mode from state each time; if it changed to `human`, ask.

8. On `milestone-done`, choose the milestone step:
   - **The PRD has more pending milestones:** run `node <skill-dir>/assets/state.js milestone <n> complete`, then `node <skill-dir>/assets/state.js set milestone=<next-n>` (the next pending number from the PRD table), set `next_action` to the next planning step, then run Stage 5 steps 3–6 for that milestone (planner, slice list, G3, then slice issues; the guard is gone, so G3 is the canvas approval in human mode and a plan-file record in auto mode). In auto mode, continue immediately; auto-record G3 only when the planner handoff is `done`, the plan exists, and the slices are imported.
   - **All MVP milestones done:** `node <skill-dir>/assets/state.js set stage=10 next_action="Run Stage 10: dispatch release-auditor three times in parallel"` and run Stage 10. In auto mode with `scope=gates`, run the release audits and deployment plan, then stop before the tag, release, and deploy and report; `scope=all` continues through them.

Close-out check before ending the session, at an autonomous stop, or before `/compact`:

```bash
node <skill-dir>/assets/state.js status
```

`in_flight` must be `null` and `next_action` must name the exact next step. Anything the next session needs that exists only in this conversation — a deferred MEDIUM, an accepted risk, a scope change — belongs in `S/findings.md` or `next_action` now: a new session and `/compact` keep what is on disk, not what was said.

## Stage 10: Release

Auto mode with `scope=gates` stops before the tag, release, and deploy steps; `scope=all` is required to run them unattended.

1. In parallel, dispatch **release-auditor** three times: production audit (`H/10-audit-production.md`), full-repo security (`H/10-audit-security.md`), and dependency audit (`H/10-audit-deps.md`).
2. CRITICAL, HIGH, or MEDIUM findings become fix slices: add them to `state.slices` and run them through Stages 8–9 first. LOW findings are recorded in the audit handoff as deferred. These audit-driven slices are outside the G3 batch: before creating their issues, ask the human (hard rule 9 and the confirmation list), or record the release audit as a new authorized batch.
3. Dispatch **deploy-planner**. HANDOFF: `H/10-deploy.md`. Its doc goes through a normal branch and PR.
4. Ask the human for the version, then confirm the tag and release:

```bash
git tag -a v<version> -m "v<version>" && git push origin v<version>
gh release create v<version> --generate-notes
```

5. Deploying follows `docs/release/<version>.md` and needs the human's confirmation. The human may run it themselves.
6. Dispatch **verifier** against the live URL, or the published package, app, or binary for non-web releases. HANDOFF: `H/10-verify.md`. Ask the human to confirm the rollback was rehearsed.

**G6:** show the audit summary, verification result, and rollback confirmation. On yes:

```bash
node <skill-dir>/assets/state.js gate G6 approved --evidence docs/release/<version>.md
node <skill-dir>/assets/state.js set stage=11
```

## Stage 11: Maintain

Ask what the work is, classify it, and route it:

| Work | Route |
|---|---|
| New capability that changes UI or flows | `goto 4` for the affected screens (G2), then planner for one new milestone (G3 canvas or auto-record), then Stages 8–9 |
| New capability with no UI change | planner for one new milestone (G3 canvas or auto-record), then Stages 8–9 |
| Behavior change | `/ecc:orch-change-feature` |
| Bug | `/ecc:orch-fix-defect` |
| Refactor | `/ecc:orch-refine-code` or `/ecc:refactor-clean` |
| Incoming issue | `/ecc:issue-review <n>` |
| Docs drifting | `/ecc:update-docs`, `/ecc:update-codemaps` |
| Next release | Stage 10 |

The `orch-*` commands run their own gates, and their changes still go through a feature branch and a PR to the base branch.

The state-writer guard stays installed after G3. When the run is finished, remove it with `bash <skill-dir>/assets/guard.sh remove --all` if the human wants.

## Stage F0: Feature preflight

Executor: orchestrator. This replaces Stages 0–7 for an existing project. Do not run `bootstrap.sh`, `git init`, or `gh repo create`.

1. Confirm this is a git repository with at least one commit. Determine `base_branch` from the repository's default branch (`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`) or the human's answer, falling back to `master` only when neither is available; record `base_commit` from `git rev-parse HEAD`. Also check that the absolute project path contains no `/docs/` or `/design/` segment; either one makes the guard exempt every file. Remember whether the guard will be ineffective. **Do not write state yet** — the state file is created in step 7.
2. Require a clean working tree (`git status --porcelain` is empty). If it is dirty, ask the human to commit, stash, or stop. Never stash or commit for them. Also require `in_flight` to be null; if a step is in flight, resume or finish it before starting the feature.
3. Read `CLAUDE.md`, every `.claude/prds/*.prd.md`, every `.claude/plans/*.plan.md`, `design/DESIGN.md`, `design/flows.md`, and `.github/workflows/`. Detect the stack's test, lint, typecheck, and build commands. Ask the human for any command you cannot find.
4. Run the baseline commands yourself. Save `H/F0-baseline.md` with the command, exit code, duration, and the last 50 lines of any failure. If the baseline is red, ask: fix first, proceed with the known failures recorded, or stop. Remember the result and the human's choice; record them in step 8.
5. Install the guard, then confirm it with `/ecc:hookify-list`:

```bash
bash <skill-dir>/assets/guard.sh install --mode feature
```

   Ensure these local-record paths are in `.gitignore` (append any missing): `.claude/*.local.md`, `.claude/settings.local.json`, `.claude/ecc-workflow/`. Without this, F5's `git add .` can commit the state directory.

6. Verify CI on the base branch and remember the latest run's conclusion and URL:

```bash
gh run list --branch <base_branch> --limit 1 --json conclusion,url
```

   Do not record G4 yet — step 8 does that after the state exists.
7. Pick the next feature number (scan `.claude/features/` for `NN-*`, use the next free number) and a kebab-case slug. Create the state; when a greenfield state exists, this appends a milestone, saves `paused`, and resets G1–G3:

```bash
node <skill-dir>/assets/state.js init --mode feature \
  --slug <slug> --spec .claude/features/<NN>-<slug>/spec.md \
  --base-branch <base_branch> --base-commit <sha>
```

8. Record the preflight results now that the state exists:

```bash
node <skill-dir>/assets/state.js set feature.guard=ineffective      # only if the path check failed
node <skill-dir>/assets/state.js set feature.baseline_status=<green|red>
node <skill-dir>/assets/state.js set feature.baseline_choice="<fix-first|proceed-with-known-failures|stop>"  # only when red
```

   Record G4 from the CI result. Green:

```bash
node <skill-dir>/assets/state.js gate G4 inherited --evidence "<run URL>"
```

   Missing or red:

```bash
node <skill-dir>/assets/state.js gate G4 pending
```

   In the missing-or-red case, offer Stage 7's ci-author and do not proceed until the human chooses.

9. Ask whether to install the optional state snapshot hooks. On yes, run `node <skill-dir>/assets/state.js hooks install` and confirm `.claude/settings.local.json` is gitignored.
10. Print the status block.

Exit: clean tree, baseline recorded, guard active, CI checked, state at `F1`.

## Stage F1: Feature spec

Executor: the **feature-spec** subagent; the orchestrator asks G1.

1. Dispatch **feature-spec**. READ: the human's request, `CLAUDE.md`, the PRD(s), the plan(s), `design/flows.md`, `H/F0-baseline.md`. WRITE: the spec path recorded at F0 (`feature.spec`), HANDOFF `H/F1-spec.md`.
2. If the feature changes the product surface rather than extending it, ask whether to run `/ecc:plan-prd` instead. On yes, that output replaces the spec; record its path in `feature.spec`.
3. If a PRD exists, ask whether to add a milestone row for this feature. On yes, the planner updates only the PRD's milestone table.
4. Show problem, users, testable acceptance criteria, out-of-scope, affected modules and screens, UI/security flags, and open questions in 10 lines or fewer.

**G1:** an explicit yes. Commit the spec and set the gate:

```bash
git add .claude/features/<NN>-<slug>/spec.md
if [ -d .claude/prds ]; then git add .claude/prds; fi
git commit -m "docs: add feature spec for <slug>"
node <skill-dir>/assets/state.js gate G1 approved --evidence .claude/features/<NN>-<slug>/spec.md
```

## Stage F2: Research (optional)

Run Stage 2 only when the spec has open questions about a new dependency, external API, data source, compliance, or a competitor's behavior. READ the spec and the PRD; HANDOFF `H/F2-research.md`. Otherwise run `node <skill-dir>/assets/state.js set feature.research=skipped` and continue.

## Stage F3: Design (UI or output-format changes only)

Run Stage 3 with these deltas: the designer reads the spec, the existing `design/DESIGN.md`, `design/design-tokens.json`, and `design/flows.md`; it changes only the affected sections, tokens, and flows, and preserves the existing direction. HANDOFF `H/F3-design.md`. Run the a11y-designer for changed flows. Commit `docs: update design for <slug>`.

No UI or output-format change: run `node <skill-dir>/assets/state.js set feature.design=skipped`, run `node <skill-dir>/assets/state.js gate G2 n/a`, and go to F5.

## Stage F4: HTML preview (UI only)

Run Stage 4 with these deltas: the preview-builder integrates the new screens and states into the existing `design/preview/index.html` hub; it does not rebuild unrelated screens. The checker compares the new screens with the existing direction. The Plan Canvas loop is unchanged.

**G2:** the canvas verdict `approve`. End the canvas, commit `docs: approve preview for <slug>`, and record the gate:

```bash
node <skill-dir>/assets/state.js gate G2 approved --evidence design/preview/index.html
```

G2 stays human in auto mode: do not record it with `--auto`.

No UI: G2 is `n/a` from F3; go to F5.

## Stage F5: Architecture and plan

1. Dispatch **architect** only if the feature adds a component, contract, data model, migration, or security boundary. HANDOFF `H/F5-architecture.md`; ADRs stay `proposed`.
2. Dispatch **planner**. READ: the spec, the existing plan, the ADRs, `design/flows.md`, `H/F0-baseline.md`. Use `state.milestone` as the new milestone number. It appends one new milestone and its slices to `.claude/plans/<name>.plan.md`, keeps existing slice ids and order, tags every new slice with `feature: <slug>` and `milestone: <state.milestone>`, and updates only the new milestone row of the PRD.
3. Append the new slices with the importer (it matches by id and preserves each existing slice's `status`, `branch`, `issue`, and `pr`), then point at the first new slice:

```bash
node <skill-dir>/assets/state.js slices import <file>
node <skill-dir>/assets/state.js set stage=F6 current_slice=<first-new-id>
```

   Keep each slice's `feature: <slug>` and `milestone: <state.milestone>` tags in the JSON; never reorder existing slices.
4. **G3:** in human mode, run the same Plan Canvas loop as Stage 4 on the updated plan. On `approve`:

```bash
ecc-plan-canvas end .claude/plans/<name>.plan.md
bash <skill-dir>/assets/guard.sh remove
git add .claude/plans
if [ -d docs/adr ]; then git add docs/adr; fi
git commit -m "docs: approve feature plan for <slug>"
node <skill-dir>/assets/state.js gate G3 approved --evidence .claude/plans/<name>.plan.md
```

   In auto mode, do not open or await the canvas. Check that the planner handoff is `Status: done`, the plan file exists, the new slices are imported, and no open question remains; flip the new ADRs to `accepted`, remove the guard, commit, and record the gate:

```bash
bash <skill-dir>/assets/guard.sh remove
git add .claude/plans
if [ -d docs/adr ]; then git add docs/adr; fi
git commit -m "docs: approve feature plan for <slug>"
node <skill-dir>/assets/state.js gate G3 approved --evidence .claude/plans/<name>.plan.md --auto
```

   G2 is not part of this shortcut: it stays a human canvas verdict in both modes.
5. Create exactly one issue per new slice, titled `[<slice-id>] <title>`, and record each number with `node <skill-dir>/assets/state.js slice <slice-id> issue=<n>`; this is required before F6. The G3 approval authorizes this batch. Never create a duplicate for a slice that already has one.

## Stage F6: Build and review the feature slices

Run Stage 8 and Stage 9 for each slice tagged with this feature, in plan order; `state.milestone` is the feature milestone, so `state.js next` returns the next feature slice. The slice-runner, branch, verification, review, PR, and G5 procedures are unchanged; `<base-branch>` resolves to `state.base_branch`, and each PR body must contain `Closes #<issue>` and add `Part of feature: <slug>` next to it. In auto mode, the continuous slice loop applies here too: after each merge, start the next tagged slice without asking.

## Stage F7: Feature wrap-up

1. Update the docs the feature changed: README, CHANGELOG or release notes, API docs, and codemaps. Use `/ecc:update-docs` and `/ecc:update-codemaps` when the change is broad. Docs changes go through a branch and PR, like every change after Stage 8.
2. Ask whether to cut a release. On yes, run Stage 10; otherwise run `node <skill-dir>/assets/state.js set feature.release=deferred`.
3. Finish the run. This archives the feature metadata, restores the paused milestone and its gates, and sets `next_action` back to the paused slice. With no paused run, it sets `mode: maintain` and `stage: 11`:

```bash
node <skill-dir>/assets/state.js finish-feature
```

4. If the human wants the snapshot hooks removed, run `node <skill-dir>/assets/state.js hooks remove`.
