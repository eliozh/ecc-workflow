#!/usr/bin/env bash
# ecc-workflow guard: install, remove, or report the Hookify rules.
# Run from the project root. Both modes install three rules: two pre-approval
# rules and one state-writer rule. `remove` keeps the state-writer rule; use
# `remove --all` to remove every rule.
set -euo pipefail

CODE_RULE=".claude/hookify.block-code-before-approval.local.md"
SCAFFOLD_RULE=".claude/hookify.block-scaffold-before-approval.local.md"
STATE_RULE=".claude/hookify.block-state-writes.local.md"

usage() {
  echo "usage: guard.sh <install|remove|status> [--mode greenfield|feature] [--all]" >&2
  exit 2
}

action="${1:-}"
case "$action" in
  install|remove|status) shift ;;
  *) usage ;;
esac

mode="greenfield"
all=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      mode="${2:-}"
      if [ "$mode" != "greenfield" ] && [ "$mode" != "feature" ]; then usage; fi
      shift 2
      ;;
    --all) all=1; shift ;;
    *) usage ;;
  esac
done

write_rule() {
  local file="$1"
  local tmp="${file}.tmp.$$"
  cat > "$tmp"
  if [ -e "$file" ] && cmp -s "$tmp" "$file"; then
    rm -f "$tmp"
    echo "ecc-workflow guard: $file already current"
    return 0
  fi
  mv "$tmp" "$file"
  echo "ecc-workflow guard: wrote $file"
}

install_rules() {
  mkdir -p .claude
  write_rule "$CODE_RULE" <<'RULE'
---
name: block-code-before-approval
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: not_contains
    pattern: /design/
  - field: file_path
    operator: not_contains
    pattern: /docs/
  - field: file_path
    operator: not_contains
    pattern: /.claude/
  - field: file_path
    operator: regex_match
    pattern: ^(?!.*(\.md|/\.gitignore)$)
---
BLOCKED by the project workflow: application code and config cannot be written until gates G2 (HTML preview) and G3 (plan) are approved. Only design/, docs/, .claude/, Markdown files, and .gitignore are writable. If you are at this gate, ask the human for approval. Do not work around this rule.
RULE

  write_rule "$SCAFFOLD_RULE" <<'RULE'
---
name: block-scaffold-before-approval
enabled: true
event: bash
action: block
pattern: (npm|pnpm|yarn|bun)\s+(create|init)\b|npx\s+\S*create-|cargo\s+(new|init)\b|go\s+mod\s+init\b|uv\s+init\b|poetry\s+(new|init)\b|django-admin\s+startproject\b|rails\s+new\b|dotnet\s+new\b|flutter\s+create\b|composer\s+create-project\b|ng\s+new\b
---
BLOCKED by the project workflow: no scaffolding until gates G2 (HTML preview) and G3 (plan) are approved. Ask the human for approval. Do not work around this rule.
RULE
  write_rule "$STATE_RULE" <<'RULE'
---
name: block-state-writes
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: (ecc-workflow/state\.json|settings\.local\.json|hookify\..*\.local\.md)$
---
BLOCKED by the project workflow: gate state, local settings, and guard rules are written only through their helpers (state.js / guard.sh). Do not edit them directly.
RULE
  echo "ecc-workflow guard: installed ($mode mode)"
}

remove_rules() {
  local removed=0
  local files=("$CODE_RULE" "$SCAFFOLD_RULE")
  if [ "$all" -eq 1 ]; then
    files+=("$STATE_RULE")
  else
    echo "ecc-workflow guard: kept $STATE_RULE (state-writer guard; use --all to remove)"
  fi
  for file in "${files[@]}"; do
    if [ -e "$file" ]; then
      rm -f "$file"
      removed=$((removed + 1))
    fi
  done
  echo "ecc-workflow guard: removed $removed rule(s)"
}

status_rules() {
  for file in "$CODE_RULE" "$SCAFFOLD_RULE" "$STATE_RULE"; do
    if [ -e "$file" ]; then
      echo "active: $file"
    else
      echo "absent: $file"
    fi
  done
}

case "$action" in
  install) install_rules ;;
  remove) remove_rules ;;
  status) status_rules ;;
esac
