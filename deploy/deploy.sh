#!/usr/bin/env bash
# deploy.sh — thin wrapper over `houston x deploy` for accounting-documents.
#
# Defaults the app name (like /fcloud deploy accounting-documents) so you only
# pass a branch and, optionally, a namespace.
#
#   dep <branch> [namespace]     deploy branch HEAD to namespace (default eng-orion)
#   dep <branch> -n              dry-run: render manifests via skiff, don't deploy
#
# Examples:
#   dep it-duplicate-tax-id-fault              # -> eng-orion
#   dep it-duplicate-tax-id-fault production   # -> production
#   dep my-branch eng-orion -n                 # skiff render only
set -euo pipefail

APP="accounting-documents"
DEFAULT_NS="eng-orion"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <branch> [namespace] [-n|--dry-run]

  <branch>     Branch to deploy (resolved to its HEAD on the remote).
  [namespace]  Target namespace (default: ${DEFAULT_NS}).
  -n           Dry-run: render manifests with 'houston x skiff', don't deploy.

Examples:
  $(basename "$0") my-branch
  $(basename "$0") my-branch production
  $(basename "$0") my-branch eng-orion -n
EOF
  exit 1
}

DRY_RUN=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)    usage ;;
    -*)           echo "Unknown flag: $arg" >&2; usage ;;
    *)            POSITIONAL+=("$arg") ;;
  esac
done

[[ ${#POSITIONAL[@]} -ge 1 ]] || usage

BRANCH="${POSITIONAL[0]}"
NAMESPACE="${POSITIONAL[1]:-$DEFAULT_NS}"
REF="${APP}@${BRANCH}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "→ skiff (dry-run): houston x skiff ${REF} ${NAMESPACE}" >&2
  exec houston x skiff "$REF" "$NAMESPACE"
fi

echo "→ deploy: houston x deploy ${REF} ${NAMESPACE}" >&2
exec houston x deploy "$REF" "$NAMESPACE"
