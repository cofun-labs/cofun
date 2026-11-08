#!/usr/bin/env bash
# Apply the repository's GitHub settings from the files in this repo.
#
# Run by a repository admin with the gh CLI signed in:
#   scripts/github-settings.sh [owner/repo]
#
# Idempotent: it reads the current settings, changes only what differs,
# and prints what it changed.

set -euo pipefail

cd "$(dirname "$0")/.."

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
api="repos/$repo"

changed() { echo "changed:   $1"; }
unchanged() { echo "unchanged: $1"; }

# Keep only the parts of a live object that the desired object also has, so
# fields GitHub adds with default values don't count as differences.
project='
def project($d):
  if ($d | type) == "object" and type == "object" then
    with_entries(.key as $k | select($d | has($k)) | .value |= project($d[$k]))
  elif ($d | type) == "array" and type == "array" and length == ($d | length) then
    [range(length) as $i | .[$i] | project($d[$i])]
  else . end;
'

# --- Rulesets ---------------------------------------------------------------

for file in .github/rulesets/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "$api/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"

  if [ -z "$id" ]; then
    gh api -X POST "$api/rulesets" --input "$file" >/dev/null
    changed "ruleset '$name' (created)"
    continue
  fi

  live="$(gh api "$api/rulesets/$id" | jq -S --slurpfile d "$file" "$project"' project($d[0])')"
  want="$(jq -S . "$file")"
  if [ "$live" = "$want" ]; then
    unchanged "ruleset '$name'"
  else
    gh api -X PUT "$api/rulesets/$id" --input "$file" >/dev/null
    changed "ruleset '$name' (updated)"
    diff <(echo "$live") <(echo "$want") | sed 's/^/  /' || true
  fi
done

# --- Repository options -----------------------------------------------------

repo_json="$(gh api "$api")"

if [ "$(jq -r .delete_branch_on_merge <<<"$repo_json")" = "true" ]; then
  unchanged "delete head branches on merge"
else
  gh api -X PATCH "$api" -F delete_branch_on_merge=true >/dev/null
  changed "delete head branches on merge (enabled)"
fi

for feature in secret_scanning secret_scanning_push_protection; do
  status="$(jq -r ".security_and_analysis.$feature.status" <<<"$repo_json")"
  if [ "$status" = "enabled" ]; then
    unchanged "$feature"
  else
    jq -n --arg f "$feature" '{security_and_analysis: {($f): {status: "enabled"}}}' |
      gh api -X PATCH "$api" --input - >/dev/null
    changed "$feature (enabled)"
  fi
done

# Dependabot security updates need vulnerability alerts turned on first.
if gh api "$api/vulnerability-alerts" --silent 2>/dev/null; then
  unchanged "Dependabot alerts"
else
  gh api -X PUT "$api/vulnerability-alerts" --silent
  changed "Dependabot alerts (enabled)"
fi

if [ "$(gh api "$api/automated-security-fixes" --jq .enabled)" = "true" ]; then
  unchanged "Dependabot security updates"
else
  gh api -X PUT "$api/automated-security-fixes" --silent
  changed "Dependabot security updates (enabled)"
fi
