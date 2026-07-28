#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# MusicD Remote — full test run.
#
#   ./test/run.sh              everything (static + unit + dom)
#   ./test/run.sh --fast       skip the headless-browser suite
#   ./test/run.sh static unit  named suites only
#
# Exits non-zero if ANY suite fails, so it works as a pre-commit gate and as a
# CI step unchanged.
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=""; RED=""; GREEN=""; YELLOW=""; OFF=""; fi

SUITES=()
FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    static|unit|dom) SUITES+=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(static unit)
  [ "$FAST" -eq 0 ] && SUITES+=(dom)
fi

# Node 22+ is required for `node --test` directory discovery and the
# node:test subtest API these suites use.
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "${RED}node 22+ required (found $(node --version 2>/dev/null || echo none))${OFF}" >&2
  exit 1
fi

# `node --test <dir>` is not supported on every Node 22 build (it tries to
# require the directory as a module), so suites are expanded to explicit files.
shopt -s nullglob

FAILED=()
for suite in "${SUITES[@]}"; do
  echo
  echo "${BOLD}── ${suite} ────────────────────────────────────────────${OFF}"
  files=( "test/${suite}"/*.test.js )
  if [ ${#files[@]} -eq 0 ]; then
    echo "${RED}[FAIL]${OFF} ${suite} — no *.test.js files found"
    FAILED+=("$suite")
    continue
  fi
  if node --test --test-reporter=spec "${files[@]}"; then
    echo "${GREEN}[PASS]${OFF} ${suite}"
  else
    echo "${RED}[FAIL]${OFF} ${suite}"
    FAILED+=("$suite")
  fi
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "${GREEN}${BOLD}[PASS]${OFF} all suites: ${SUITES[*]}"
  exit 0
fi
echo "${RED}${BOLD}[FAIL]${OFF} failing suites: ${FAILED[*]}"
echo "${YELLOW}Do not commit.${OFF} See CLAUDE.md — regressions are a failure, not a follow-up task."
exit 1
