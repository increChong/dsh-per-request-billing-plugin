#!/usr/bin/env bash
# Create the GitHub repository for this package and push it.
#
#   GITHUB_TOKEN=<token> ./scripts/publish-to-github.sh <owner>/<repo>
#
# The token needs `repo` (classic) or, for a fine-grained token, Contents:
# read+write on the target repository plus Administration: read+write if the
# repository must be created as well. Point it at an existing empty repository
# to avoid needing the Administration permission.
#
# git transport to github.com is blocked in some sandboxes; when the push fails
# with a connection error but api.github.com answers, fall back to
# `scripts/publish-via-api.mjs` (it appends the commit through the REST API).
set -euo pipefail

TARGET="${1:-}"
BRANCH="${2:-main}"
API="https://api.github.com"

if [[ -z "$TARGET" ]]; then
  echo "usage: GITHUB_TOKEN=... $0 <owner>/<repo> [branch]" >&2
  exit 2
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is not set; refusing to guess credentials." >&2
  exit 2
fi

REPO_NAME="${TARGET##*/}"

echo "==> repository $TARGET"
if curl -fsS -o /dev/null -H "Authorization: Bearer $GITHUB_TOKEN" "$API/repos/$TARGET"; then
  echo "    exists"
else
  echo "    creating"
  curl -fsS -X POST "$API/user/repos" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"$REPO_NAME\",\"private\":false,\"description\":\"Per-request (per-call) billing optimizer for DeepSeek Harness\"}" \
    -o /dev/null
  echo "    created"
fi

echo "==> pushing $BRANCH"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$TARGET.git"
git push -u "https://x-access-token:$GITHUB_TOKEN@github.com/$TARGET.git" "$BRANCH:$BRANCH"
git remote set-url origin "https://github.com/$TARGET.git"

echo
echo "pushed: https://github.com/$TARGET"
