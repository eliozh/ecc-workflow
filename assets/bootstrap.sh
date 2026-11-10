#!/usr/bin/env bash
# Stage 0 of ecc-workflow: create the repo, the pre-approval code guard,
# and the local state directory. Run from the new project's root.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -e .claude/ecc-workflow/state.json ]; then
  echo "ecc-workflow: state already exists here; use /ecc-workflow resume" >&2
  exit 1
fi
case "$(pwd)/" in
  */docs/*|*/design/*)
    echo "ecc-workflow: project path contains /docs/ or /design/, which would disable the guard; move the project" >&2
    exit 1 ;;
esac
if [ -n "$(ls -A | grep -v '^\.' || true)" ]; then
  echo "ecc-workflow: folder is not empty; this workflow starts from an empty folder" >&2
  exit 1
fi

[ -d .git ] || git init -q -b master
mkdir -p .claude/ecc-workflow/handoffs .claude/ecc-workflow/slices .claude/ecc-workflow/screens design/preview docs/adr

touch .gitignore
for line in '.claude/*.local.md' '.claude/settings.local.json' '.claude/ecc-workflow/' '.env' '.env.*' '!.env.example'; do
  grep -qxF -- "$line" .gitignore || printf '%s\n' "$line" >> .gitignore
done

bash "${script_dir}/guard.sh" install --mode greenfield

git add .gitignore
git commit -q -m "chore: bootstrap repository"
echo "ecc-workflow: bootstrapped on branch $(git branch --show-current)"
