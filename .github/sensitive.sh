#!/usr/bin/env bash
# Lists what the pull request BASE...HEAD changes that the user wants to see before it
# reaches main, and fails unless OK=true (the label "ok"). Run by sensitive.yml; locally:
#   BASE=origin/main HEAD=HEAD .github/sensitive.sh
set -euo pipefail

# Dependencies, permissions, version and signing, sign-in and key storage, the model's
# questions, the privacy policy, and the rules for agents and CI.
paths='^(package\.json|android/app/build\.gradle|android/app/src/main/AndroidManifest\.xml|src/core/auth\.ts|src/app/platform\.ts|src/core/engine/prompts\.ts|PRIVACY\.md|AGENTS\.md|\.github/)'
export LC_ALL=C
base=$(git merge-base "$BASE" "$HEAD") # fails the check when the history is missing
files=$(git diff --name-only "$base" "$HEAD" | { grep -E "$paths" || true; })

# A web address the app has not used before is a new service it talks to.
code=(src modules App.tsx)
known=$({ git grep -hoE 'https?://[A-Za-z0-9.-]+' "$base" -- "${code[@]}" || [ $? = 1 ]; } | sort -u) # 1: none yet
hosts=$(git diff -U0 "$base" "$HEAD" -- "${code[@]}" | { grep '^+' || true; } | { grep -oE 'https?://[A-Za-z0-9.-]+' || true; } | sort -u | comm -23 - <(echo "$known"))

if [ -z "$files$hosts" ]; then
  echo "Nothing sensitive."
  exit 0
fi
echo "Changes the user looks at before they reach main:"
[ -n "$files" ] && echo "$files" | sed 's/^/  /'
[ -n "$hosts" ] && echo "$hosts" | sed 's/^/  new web address: /'
if [ "${OK:-false}" = true ]; then
  echo "Let through with the label \"ok\"."
  exit 0
fi
echo "::error::Waiting for the user: they add the label \"ok\" once they have looked at it."
exit 1
