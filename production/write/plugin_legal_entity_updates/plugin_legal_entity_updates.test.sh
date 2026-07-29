#!/usr/bin/env bash
#
# Smoke test for plugin_legal_entity_updates.js — the command-line surface only.
#
# WHY THIS FILE EXISTS: the flag surface was removed wholesale in 196310f and
# restored afterwards, and nothing failed in between, because the assertions that
# covered it were only ever run by hand. Anything a caller depends on — a flag
# name, an exit code, the stdout/stderr split, and above all which modes refuse to
# run without a terminal — is checked here so it cannot go quiet again.
#
# TOUCHES NO DATABASE. `psql` and `houston` are stubbed to fail instantly, so any
# path that reaches the network dies immediately instead of hanging on the VPN.
# That also means this test cannot check payload VALUES — only that the surface
# behaves. Field values need one real run against a namespace.
#
#   ./plugin_legal_entity_updates.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS="$HERE/plugin_legal_entity_updates.js"

STUB="$(mktemp -d)"
cat > "$STUB/psql" <<'EOF'
#!/bin/sh
echo "psql: stub — no connection" >&2
exit 2
EOF
cat > "$STUB/houston" <<'EOF'
#!/bin/sh
echo "houston: stub — refusing to run" >&2
exit 2
EOF
chmod +x "$STUB/psql" "$STUB/houston"
export PATH="$STUB:$PATH"
trap 'rm -rf "$STUB" "$TMPDIR_T"' EXIT

TMPDIR_T="$(mktemp -d)"
PASS=0
FAIL=0

# Every invocation gets </dev/null: stdin is deliberately NOT a terminal, which is
# the condition most of these assertions are about.
run() { node "$JS" "$@" </dev/null >"$TMPDIR_T/out" 2>"$TMPDIR_T/err"; echo $?; }

ok()   { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }

# exit code
expect_exit() { # <want> <label> -- <args...>
  local want=$1 label=$2; shift 3
  local got; got=$(run "$@")
  [ "$got" = "$want" ] && ok "$label" || bad "$label" "expected exit $want, got $got"
}

# a regex must appear on stdout+stderr combined
expect_match() { # <regex> <label> -- <args...>
  local re=$1 label=$2; shift 3
  run "$@" >/dev/null
  if cat "$TMPDIR_T/out" "$TMPDIR_T/err" | grep -qE "$re"; then ok "$label"
  else bad "$label" "no match for /$re/"; fi
}

# a regex must NOT appear
expect_no_match() { # <regex> <label> -- <args...>
  local re=$1 label=$2; shift 3
  run "$@" >/dev/null
  if cat "$TMPDIR_T/out" "$TMPDIR_T/err" | grep -qE "$re"; then bad "$label" "unexpected match for /$re/"
  else ok "$label"; fi
}

echo
echo "── flags parse ────────────────────────────────────────"
expect_exit 0 "--help exits 0" -- --help
expect_match '^\s+-n, --namespace' "--help lists the flags" -- --help
expect_match '^\s+--yes' "--help documents --yes" -- --help
expect_exit 2 "unknown flag is an error" -- --nope
expect_match 'Unknown option "--nope"' "unknown flag names itself" -- --nope
expect_exit 2 "-n without a value is an error" -- -n --json
expect_exit 2 "--batch-size rejects non-numbers" -- --migrate --batch-size abc 33
expect_exit 2 "--all is refused by --migrate" -- --migrate --all
expect_exit 2 "--all is refused by --reset" -- --reset --all
expect_match 'not allowed with --migrate' "the --all refusal explains itself" -- --migrate --all

echo
echo "── modes route ────────────────────────────────────────"
# The read gate echoes the resolved mode before any query, so it is observable
# without a database.
expect_match 'mode +: postflight' "--verify is an alias for --postflight" -- --verify --yes 33
expect_match 'mode +: preflight' "--preflight selects pre-flight" -- --preflight --yes 33
expect_match 'mode +: plugins' "--plugins selects the audit" -- --plugins --yes 33
expect_match 'namespace *: eng-orion' "namespace defaults to staging" -- --preflight --yes 33
expect_match 'namespace *: eng-whatever' "-n overrides the namespace" -- --preflight --yes -n eng-whatever 33

echo
echo "── providers ──────────────────────────────────────────"
expect_exit 2 "no providers and no terminal is an error" -- --preflight --yes
expect_match 'No providers given' "that error names the alternatives" -- --preflight --yes
expect_exit 2 "--file on a missing path is an error" -- --preflight --yes -f /nonexistent/ids.txt
printf '# a comment\n33\n41  # trailing\n' > "$TMPDIR_T/ids.txt"
expect_no_match 'No provider IDs found' "--file reads IDs and strips comments" -- --preflight --yes -f "$TMPDIR_T/ids.txt"
: > "$TMPDIR_T/empty.txt"
expect_exit 2 "--file with no IDs is an error" -- --preflight --yes -f "$TMPDIR_T/empty.txt"

echo
echo "── the boundary: writes need a terminal ───────────────"
# This is the safety-relevant block. --yes must NOT buy any of these.
for spec in "--link --apply --yes 33" "--migrate --yes 33" "--reset --yes 33"; do
  # shellcheck disable=SC2086
  expect_exit 2 "refused without a TTY: $spec" -- $spec
  # shellcheck disable=SC2086
  expect_match 'Refusing to write without an interactive terminal' "…and says why: $spec" -- $spec
done
expect_exit 2 "prod apply refused without a TTY" -- --link --apply --yes -n production 33
expect_exit 2 "piped stdin without --yes is refused" -- --preflight 33
expect_match 'not a TTY' "…and explains the pipe" -- --preflight 33
expect_exit 2 "reset refuses production outright" -- --reset -n production 33

echo
echo "── the boundary: read-only modes may proceed ──────────"
# These must get PAST the terminal gate. They then fail at the stubbed psql, which
# is fine — what matters is that the gate is not what stopped them.
for spec in "--preflight --yes 33" "--postflight --yes 33" "--plugins --yes 33" "--link --dry-run --yes 33"; do
  # shellcheck disable=SC2086
  expect_no_match 'without an interactive terminal' "allowed past the gate: $spec" -- $spec
done
expect_match 'approved *: --yes' "--yes approves the read gate" -- --preflight --yes 33

echo
echo "── --json contract ────────────────────────────────────"
node "$JS" --preflight --yes 33 --json </dev/null >"$TMPDIR_T/j.out" 2>"$TMPDIR_T/j.err"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMPDIR_T/j.out" 2>/dev/null; then
  ok "stdout is parseable JSON and nothing else"
else
  bad "stdout is parseable JSON and nothing else" "$(head -c 120 "$TMPDIR_T/j.out")"
fi
[ -s "$TMPDIR_T/j.err" ] && ok "the human report goes to stderr" || bad "the human report goes to stderr"
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (typeof d.exit !== "number") { console.error("no numeric exit"); process.exit(1); }
  if (d.schema_version !== 1) { console.error("no schema_version"); process.exit(1); }
' "$TMPDIR_T/j.out" 2>/dev/null \
  && ok "the document carries schema_version and exit" \
  || bad "the document carries schema_version and exit"
# Without --json the payload must not appear on stdout.
node "$JS" --preflight --yes 33 </dev/null 2>/dev/null | head -1 | grep -q '^{' \
  && bad "no JSON on stdout without --json" \
  || ok "no JSON on stdout without --json"

echo
echo "── pre-flight with nothing to compare ─────────────────"
# The one case with its own stub. Everything above dies at the stubbed psql on
# purpose; this needs answers, because the bug being guarded against was a
# green PASS with exit 0 when pre-flight compared nothing at all.
#
# This houston says: nobody has an active primary legal entity, and only 33 has a
# billing row — the two halves of the diagnosis the output has to tell apart.
# Lives under TMPDIR_T so the existing trap cleans it up.
STUB2="$TMPDIR_T/stub2"
mkdir -p "$STUB2"
cat > "$STUB2/houston" <<'EOF'
#!/usr/bin/env bash
sql="${!#}"    # `houston psql <env> <db> -- … -c <sql>`
case "$sql" in
  *provider_purchases_primary_legal_entities*) : ;;                     # nobody migrated
  *provider_billing_informations*)             echo "33||||||||||||||" ;;
  *)                                           : ;;
esac
exit 0
EOF
chmod +x "$STUB2/houston"

run2() { PATH="$STUB2:$PATH" node "$JS" "$@" </dev/null >"$TMPDIR_T/o2" 2>"$TMPDIR_T/e2"; echo $?; }
match2() { cat "$TMPDIR_T/o2" "$TMPDIR_T/e2" | grep -qE "$1"; }

got=$(run2 --preflight --yes 33,41)
[ "$got" = "1" ] && ok "nothing to compare exits ${got:-?} (data error)" \
  || bad "nothing to compare exits 1" "got $got"
match2 'PRE-FLIGHT: FAIL' && ok "…and the verdict is FAIL" || bad "…and the verdict is FAIL"
match2 'Nothing was compared' && ok "…and says nothing was compared" \
  || bad "…and says nothing was compared"
match2 'Going further is pointless' && ok "…and that continuing is pointless" \
  || bad "…and that continuing is pointless"
# The two halves of the diagnosis, which need the extra billing read to tell apart.
match2 'provider=33 — billing details are present' && ok "33: names migrate as the fix" \
  || bad "33: names migrate as the fix"
match2 'provider=41 — no active provider_billing_informations row' \
  && ok "41: names the missing billing row instead" \
  || bad "41: names the missing billing row instead"

got=$(run2 --preflight --yes 33 --json)
[ "$got" = "1" ] && ok "a single unmigrated provider also exits 1" \
  || bad "a single unmigrated provider also exits 1" "got $got"
match2 'provider=33 has no active primary legal entity' \
  && ok "…and the wording is singular" || bad "…and the wording is singular"
PATH="$STUB2:$PATH" node "$JS" --preflight --yes 33,41 --json </dev/null >"$TMPDIR_T/j2.out" 2>/dev/null
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fail = (m) => { console.error(m); process.exit(1); };
  if (d.verdict !== "FAIL") fail(`verdict ${d.verdict}, want FAIL`);
  if (d.exit !== 1) fail(`exit ${d.exit}, want 1`);
  if (d.tally.no_primary_legal_entity !== 2) fail("tally.no_primary_legal_entity !== 2");
  if (d.skipped.length !== 2) fail("expected 2 skipped");
  // The flag that lets a caller tell "run migrate" from "there is nothing to migrate".
  const flags = d.skipped.map((s) => s.has_billing_details);
  if (flags[0] !== true || flags[1] !== false) fail(`has_billing_details ${JSON.stringify(flags)}`);
' "$TMPDIR_T/j2.out" \
  && ok "the payload carries FAIL, the count, and has_billing_details" \
  || bad "the payload carries FAIL, the count, and has_billing_details"

# The other half of the rule: SOME providers missing a pointer must not fail a run
# whose compared providers agree, or a bulk --all sweep would be permanently red.
cat > "$STUB2/houston" <<'EOF'
#!/usr/bin/env bash
sql="${!#}"
case "$sql" in
  *provider_purchases_primary_legal_entities*) echo "33|019f-aaa" ;;    # 33 migrated, 41 not
  *provider_billing_informations*)             echo "33||||||||||||||" ;;
  *account_configuration_plugins*)             : ;;
  *legal_entities*)                            echo "019f-aaa|_column.country_code|" ;;
  *account_configurations*)                    echo "33|" ;;
  *)                                           : ;;
esac
exit 0
EOF
got=$(run2 --preflight --yes --summary 33,41)
[ "$got" = "0" ] && ok "a partly-migrated batch still exits 0" \
  || bad "a partly-migrated batch still exits 0" "got $got"
match2 'PRE-FLIGHT: PASS' && ok "…with a PASS verdict" || bad "…with a PASS verdict"
match2 '⊘ 1 provider was NOT checked' && ok "…but the gap is still reported" \
  || bad "…but the gap is still reported"

echo
echo "── interactive default is intact ──────────────────────"
# With no flags and no terminal the script must ask for nothing and refuse
# cleanly — it must not hang waiting on a prompt it can never receive.
expect_exit 2 "no flags, no terminal: refuses instead of hanging" --
expect_match 'No mode given' "…and says a mode flag is needed" --

echo
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
