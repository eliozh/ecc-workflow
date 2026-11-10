# Stage procedures

Load one section at a time:

```bash
sed -n '/^## Stage N:/,/^## Stage /p' <skill-dir>/references/stages.md
```

`H` below means `.claude/ecc-workflow/handoffs`, and `S` means `.claude/ecc-workflow/slices/<slice-id>`. Every subagent is briefed per `references/subagents.md`. Update state through `assets/state.js` after each numbered step.

Three sequences share this file:

- **Greenfield:** Stages 0–11.
- **Feature:** Stages F0–F7, then back to the paused milestone.
- **Shared:** 2, 3, 4, 5, 8, 9, and 10 are reused by feature mode; their procedures are unchanged unless an F-stage section says otherwise. In feature mode, replace `master` in branch and diff commands with `state.base_branch`.

## Stage 0: Bootstrap

Executor: orchestrator.

1. Confirm the folder is empty except dotfiles, and that its absolute path contains no `/docs/` or `/design/` segment. Either one makes the guard exempt every file; if so, stop and ask the human to move the project.
2. Run the bootstrap script from the project root:

```bash
bash <skill-dir>/assets/bootstrap.sh
```

3. Write the initial state through the helper:

```bash
node <skill-dir>/assets/state.js init --mode greenfield --project <name>
```

   Also ask whether to install the optional state snapshot hooks. On yes, run `node <skill-dir>/assets/state.js hooks install`; `bootstrap.sh` already gitignores `.claude/settings.local.json`.
4. Confirm both rules are active with `/ecc:hookify-list`. If hooks are off, stop and tell the human how to enable them.

Exit: both guard rules listed, one commit on `master`.

## Stage 1: PRD

Executor: orchestrator. This stage questions the human, so it can't be delegated.

1. Run `/ecc:plan-prd <idea>` and answer its gates with the human. Use `/ecc:prp-prd` instead only if the human asks for deeper discovery.
2. Optionally, if the human wants it: `ecc:product-lens` to pressure-test the idea, or `ecc:council` for a contested scope call.
3. Record `prd` in state.

**G1:** show problem, primary user, hypothesis with measurable outcome, MVP, and out-of-scope list in 10 lines or fewer. On an explicit yes: commit `docs: add PRD`, set G1 approved.

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
```

## Stage 5: Architecture and plan

1. Dispatch **architect**. READ: PRD, `H/02-research.md`, `design/DESIGN.md`, `design/flows.md`, `design/preview/index.html`. HANDOFF: `H/05-architecture.md`.
2. Show the human the options and recommendation (from the summary) and ask them to choose the stack. Record `stack` in state, using an id from the stack table in `WORKFLOW.md` when one fits.
3. Dispatch **planner**. READ: PRD, the ADRs, `H/05-architecture.md`, `design/flows.md`. HANDOFF: `H/05-plan.md`.
4. Copy the slice list from the plan into `state.slices`.
5. **G3:** run the same Plan Canvas loop as Stage 4 on `.claude/plans/<name>.plan.md`, dispatching planner (or architect, for ADR changes) to apply feedback. On `approve`:

```bash
ecc-plan-canvas end .claude/plans/<name>.plan.md
bash <skill-dir>/assets/guard.sh remove
```

6. After `approve`, create exactly one issue per slice before any slice work, titled `[<slice-id>] <title>` (the M1 format). This is required: do not proceed to Stage 6 or Stage 8 without it. Each body names the milestone, the plan path and §4 of the plan, whether a security review is required, and the done-when: the slice's acceptance criteria pass in CI `verify` and the PR body contains `Closes #<issue>`. Record the issue numbers in `state.slices`. The G3 plan approval authorizes this batch; it needs no separate confirmation.
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
2. Ask for the repo name and visibility. On confirmation:

```bash
gh repo create <name> --private --source=. --push
```

3. Watch CI (background). If it fails, follow the CI-failure rule in `SKILL.md`.

```bash
gh run watch --exit-status
```

4. Ask to enable branch protection. On confirmation, apply it, using a review count of `0` when solo:

```bash
gh api -X PUT repos/<owner>/<name>/branches/master/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
EOF
```

   If the plan doesn't support it (private repo on the free plan), tell the human and record `protection: "convention"` in state.
5. Read it back, without test-pushing to `master`:

```bash
gh api repos/<owner>/<name>/branches/master/protection --jq '.required_status_checks.contexts'
```

6. First milestone only, or any milestone planned through Stage 7: ensure every slice has exactly one issue. Create any missing issues in the `[<slice-id>] <title>` format from Stage 5 and record the numbers in `state.slices`, skipping any slice that already has one. Milestones planned later create their issues through Stage 5 step 6; never create a duplicate issue for a slice that already has one.
7. Remind the human to enable secret scanning, push protection, Dependabot alerts, and CodeQL under Settings → Code security. These aren't done by the skill.

**G4:** show the green run link and the protection read-back. On yes, set G4 approved, `stage: 8`, `current_slice` = first pending slice.

## Stage 8: Build one slice

Repeat per slice. One slice equals one branch equals one PR.

1. Branch from an up-to-date `master`:

```bash
git switch master && git pull --ff-only && git switch -c feat/<slice-id>
```

2. Extract the slice's section of the plan into `S/brief.md`. Add the preview screens it implements and the stack's test command.
3. Dispatch **implementer**. READ: `S/brief.md`, `CLAUDE.md`, relevant ADRs, plus `design/preview/index.html` for UI slices. HANDOFF: `S/implement.md`.
4. If it returns `needs-human` because the design must change: run `goto 4` with the human for that screen, re-approve G2, then resume this slice.
5. Run the test command yourself. On a build break, dispatch **build-fixer** with the error saved to `S/build-<n>.md`.
6. In parallel: **verifier** (HANDOFF `S/verify.md`) and, when the slice includes a critical journey, **e2e** (HANDOFF `S/e2e.md`).
7. Any FAIL: dispatch fixer or build-fixer with the failing checks, then re-verify. Two rounds at most, then escalate.
8. Commit with a Conventional Commit message written from the handoff summaries, for example `feat(<scope>): <slice title>`.

Exit: verification passes.

## Stage 9: Code and security review

1. Dispatch reviewers **in parallel**, each read-only with scope `git diff master...HEAD`:
   - always: `ecc:code-reviewer` and the stack reviewer (stack table in `WORKFLOW.md`)
   - `security: true` slice or a diff touching auth, user input, queries, file paths, external APIs, crypto, payments, or secrets: `ecc:security-reviewer`
   - `ui: true`: `ecc:a11y-architect` (review only)
   - hot paths, bundle growth, slow queries: `ecc:performance-optimizer` (review only)
   - schema or query changes: `ecc:database-reviewer`
2. Save each report to `S/review-<kind>.md`. Merge the findings tables into `S/findings.md`, removing duplicates.
3. CRITICAL, HIGH, or MEDIUM findings: dispatch **fixer** with those rows. LOW findings are recorded in `S/findings.md` as deferred unless the human asks for them. Re-run only the reviewers that raised them. A HIGH (or a deliberately accepted MEDIUM) may be accepted only with the human's written reason, recorded in `S/findings.md` and the PR body.
4. Push and open the PR:

```bash
git push -u origin feat/<slice-id>
```

   Then run `/ecc:pr master`. The body must contain `Closes #<issue>` so merging the PR closes the issue; if `state.base_branch` is not the repository default branch, close the issue explicitly after the merge. Also add the MEDIUM findings for traceability: MEDIUMs are fixed before merge, so this list records what was fixed plus any accepted or deferred item.
5. Watch checks in the background, and handle failures with build-fixer:

```bash
gh pr checks <n> --watch
```

6. PR-level review: `/ecc:orch-review <n>` for security slices, otherwise `/ecc:review-pr <n>`. Save the output to `S/pr-review.md`. Use `/ecc:santa-loop` instead for auth, payments, or migrations if the human wants it. New CRITICAL, HIGH, or MEDIUM findings go back to step 3.

**G5:** show the PR link, check status, and finding counts by severity, and ask "merge?". On an explicit yes:

```bash
gh pr merge <n> --squash --delete-branch
git switch master && git pull --ff-only
```

Set the slice to `merged`. Next pending slice: back to Stage 8. Milestone done but the PRD has more pending milestones: mark the milestone `complete`, then run Stage 5 steps 3–6 for the next milestone (planner, slice list, G3, then slice issues; the guard is gone, so G3 is only the canvas approval). All MVP milestones done: Stage 10.

## Stage 10: Release

1. In parallel, dispatch **release-auditor** three times: production audit (`H/10-audit-production.md`), full-repo security (`H/10-audit-security.md`), and dependency audit (`H/10-audit-deps.md`).
2. CRITICAL, HIGH, or MEDIUM findings become fix slices: add them to `state.slices` and run them through Stages 8–9 first. LOW findings are recorded in the audit handoff as deferred.
3. Dispatch **deploy-planner**. HANDOFF: `H/10-deploy.md`. Its doc goes through a normal branch and PR.
4. Ask the human for the version, then confirm the tag and release:

```bash
git tag -a v<version> -m "v<version>" && git push origin v<version>
gh release create v<version> --generate-notes
```

5. Deploying follows `docs/release/<version>.md` and needs the human's confirmation. The human may run it themselves.
6. Dispatch **verifier** against the live URL, or the published package, app, or binary for non-web releases. HANDOFF: `H/10-verify.md`. Ask the human to confirm the rollback was rehearsed.

**G6:** show the audit summary, verification result, and rollback confirmation. On yes, set G6 approved and `stage: 11`.

## Stage 11: Maintain

Ask what the work is, classify it, and route it:

| Work | Route |
|---|---|
| New capability that changes UI or flows | `goto 4` for the affected screens (G2), then planner for one new milestone (G3 canvas), then Stages 8–9 |
| New capability with no UI change | planner for one new milestone (G3 canvas), then Stages 8–9 |
| Behavior change | `/ecc:orch-change-feature` |
| Bug | `/ecc:orch-fix-defect` |
| Refactor | `/ecc:orch-refine-code` or `/ecc:refactor-clean` |
| Incoming issue | `/ecc:issue-review <n>` |
| Docs drifting | `/ecc:update-docs`, `/ecc:update-codemaps` |
| Next release | Stage 10 |

The `orch-*` commands run their own gates, and their changes still go through a feature branch and a PR to `master`.

## Stage F0: Feature preflight

Executor: orchestrator. This replaces Stages 0–7 for an existing project. Do not run `bootstrap.sh`, `git init`, or `gh repo create`.

1. Confirm this is a git repository with at least one commit. Record `base_branch` (default `master`) and `base_commit` from `git rev-parse HEAD`. Also check that the absolute project path contains no `/docs/` or `/design/` segment; either one makes the guard exempt every file. If it does, tell the human the guard will be ineffective and run `node <skill-dir>/assets/state.js set feature.guard=ineffective`.
2. Require a clean working tree (`git status --porcelain` is empty). If it is dirty, ask the human to commit, stash, or stop. Never stash or commit for them.
3. Read `CLAUDE.md`, every `.claude/prds/*.prd.md`, every `.claude/plans/*.plan.md`, `design/DESIGN.md`, `design/flows.md`, and `.github/workflows/`. Detect the stack's test, lint, typecheck, and build commands. Ask the human for any command you cannot find.
4. Run the baseline commands yourself. Save `H/F0-baseline.md` with the command, exit code, duration, and the last 50 lines of any failure. If the baseline is red, ask: fix first, proceed with the known failures recorded, or stop. Record the result and the human's choice, for example `node <skill-dir>/assets/state.js set feature.baseline_status=green`.
5. Install the guard, then confirm it with `/ecc:hookify-list`:

```bash
bash <skill-dir>/assets/guard.sh install --mode feature
```

   Ensure these local-record paths are in `.gitignore` (append any missing): `.claude/*.local.md`, `.claude/settings.local.json`, `.claude/ecc-workflow/`. Without this, F5's `git add .` can commit the state directory.

6. Verify CI on the base branch:

```bash
gh run list --branch <base_branch> --limit 1 --json conclusion,url
```

   If the latest run is green, record G4 as inherited with the run URL. If it is missing or red, offer Stage 7's ci-author and keep G4 pending.
7. Ask whether to install the optional state snapshot hooks. On yes, run `node <skill-dir>/assets/state.js hooks install` and confirm `.claude/settings.local.json` is gitignored.
8. Pick the next feature number (scan `.claude/features/` for `NN-*`, use the next free number) and a kebab-case slug. Create the state; when a greenfield state exists, this appends a milestone, saves `paused`, and resets G1–G3:

```bash
node <skill-dir>/assets/state.js init --mode feature \
  --slug <slug> --spec .claude/features/<NN>-<slug>/spec.md \
  --base-branch <base_branch> --base-commit <sha>
```

9. Print the status block.

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

No UI or output-format change: run `node <skill-dir>/assets/state.js set feature.design=skipped`, set G2 `n/a`, and go to F5.

## Stage F4: HTML preview (UI only)

Run Stage 4 with these deltas: the preview-builder integrates the new screens and states into the existing `design/preview/index.html` hub; it does not rebuild unrelated screens. The checker compares the new screens with the existing direction. The Plan Canvas loop is unchanged.

**G2:** the canvas verdict `approve`. End the canvas, commit `docs: approve preview for <slug>`, and set G2 approved. No UI: G2 `n/a` from F3, go to F5.

## Stage F5: Architecture and plan

1. Dispatch **architect** only if the feature adds a component, contract, data model, migration, or security boundary. HANDOFF `H/F5-architecture.md`; ADRs stay `proposed`.
2. Dispatch **planner**. READ: the spec, the existing plan, the ADRs, `design/flows.md`, `H/F0-baseline.md`. Use `state.milestone` as the new milestone number. It appends one new milestone and its slices to `.claude/plans/<name>.plan.md`, keeps existing slice ids and order, tags every new slice with `feature: <slug>`, and updates only the new milestone row of the PRD.
3. Append the new slices to `state.slices`, preserving each slice's `feature: <slug>` tag; do not reorder existing slices. Set `stage: F6` and `current_slice` to the first new slice.
4. **G3:** the same Plan Canvas loop as Stage 4 on the updated plan. On `approve`:

```bash
ecc-plan-canvas end .claude/plans/<name>.plan.md
bash <skill-dir>/assets/guard.sh remove
git add .claude/plans
if [ -d docs/adr ]; then git add docs/adr; fi
git commit -m "docs: approve feature plan for <slug>"
node <skill-dir>/assets/state.js gate G3 approved --evidence .claude/plans/<name>.plan.md
```

   Flip the new ADRs to `accepted` before committing.
5. Create exactly one issue per new slice, titled `[<slice-id>] <title>`, and record the numbers in `state.slices`; this is required before F6. The G3 approval authorizes this batch. Never create a duplicate for a slice that already has one.

## Stage F6: Build and review the feature slices

Run Stage 8 and Stage 9 for each slice tagged with this feature, in plan order. The branch, verification, review, PR, and G5 procedures are unchanged, except that `master` becomes `state.base_branch` and each PR body must contain `Closes #<issue>` and add `Part of feature: <slug>` next to it.

## Stage F7: Feature wrap-up

1. Update the docs the feature changed: README, CHANGELOG or release notes, API docs, and codemaps. Use `/ecc:update-docs` and `/ecc:update-codemaps` when the change is broad. Docs changes go through a branch and PR, like every change after Stage 8.
2. Ask whether to cut a release. On yes, run Stage 10; otherwise run `node <skill-dir>/assets/state.js set feature.release=deferred`.
3. Finish the run. This archives the feature metadata, restores the paused milestone and its gates, and sets `next_action` back to the paused slice. With no paused run, it sets `mode: maintain` and `stage: 11`:

```bash
node <skill-dir>/assets/state.js finish-feature
```

4. If the human wants the snapshot hooks removed, run `node <skill-dir>/assets/state.js hooks remove`.
