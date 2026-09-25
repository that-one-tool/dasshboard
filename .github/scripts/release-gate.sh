#!/usr/bin/env bash
# Decide whether a commit should cut a desktop release; prints "true" or "false".
# Usage: release-gate.sh "<full commit message>"
#
# Follows Conventional Commits on the message header (case-insensitive): release
# on feat / fix / perf, on any breaking change (`type!:`), and on the manual
# `Release vX.Y.Z` version-bump commits. Everything else (chore, docs, ci,
# refactor, style, test, merges) is tested but not released. The `(site)`
# scope belongs to the website (apps/website) and never releases the desktop app.
set -eu

header=${1%%$'\n'*}

if printf '%s' "$header" | grep -qiE '^[a-z]+\(site\)!?:'; then
    echo false
elif printf '%s' "$header" | grep -qiE '^([a-z]+(\([^)]+\))?!:|(feat|fix|perf)(\([^)]+\))?:|Release v[0-9])'; then
    echo true
else
    echo false
fi
