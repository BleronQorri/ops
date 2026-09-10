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
for spec in "--link --apply --yes 33" "--migrate --yes 33" "--reset --yes 33" \
            "--reset --clear-einvoicing --yes 33"; do
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
echo "── rollout report ─────────────────────────────────────"
# Fixture: 33 migrated but its entity is missing SA's buildingNumber/district;
# 71 not migrated with complete billing; 72 not migrated with no billing row;
# 90 in GB — no e-invoicing rules; 91 with no country on its config; 92 an ES sole
# trader; 101/102 in IT (one complete, one missing tax_number) so the single-country
# rule is exercised on the country the rollout actually asks about; one config row
# with no provider_id. Eight resolvable providers in total.
STUB3="$TMPDIR_T/stub3"
mkdir -p "$STUB3"
cat > "$STUB3/houston" <<'EOF'
#!/usr/bin/env bash
sql="${!#}"
case "$sql" in
  *provider_purchases_primary_legal_entities*) echo "33|019f-aaa" ;;
  *provider_billing_informations*)
    echo "33|My business|||SA|Riyadh Province|Riyadh|12896|Al Faisaliyyah|311268874200003|7394826150||1234|1234|"
    echo "71|Riyadh Co|||SA|Riyadh Province|Riyadh|12896|King Fahd Rd|311268874200003|7394826150||9876|Al Olaya|"
    echo "90|British Ltd|||GB|London|London|EC1A 1BB|1 High St|GB123456789|12345678||||"
    echo "91|Mystery Co|||||||1 Some Rd||||||"
    # ES sole trader: no company_name, but a person's name. ES requires a legal name,
    # and which column satisfies it depends on the entity type migrate picks.
    echo "92||Pihli|Ohlau|ES|Madrid|San Agustin|28001|calle los claveles|Y0021621S|||||"
    # IT: same required set as ES. 101 has everything, 102 is missing tax_number.
    echo "101|Milano Srl|||IT|Lombardia|Milano|20121|Via Roma 1|IT12345678901|12345678901||||"
    echo "102|Napoli Srl|||IT|Campania|Napoli|80100|Via Toledo 2||||||"
    ;;
  *FROM\ providers*)          # fetchPaymentsEnabled: 0 not_set, 1 enabled, 2 disabled
    echo "71|1"; echo "72|0"; echo "90|2"; echo "91|0"; echo "92|1"
    echo "101|1"; echo "102|0" ;;
  # Eight fields, in fetchPlugins' column order: provider, plugin, type, integrator,
  # plugin_status, legal_entity_id, integration, third_party_integration_status. Short rows
  # are dropped by parseRowsLoose, so a stale stub silently means "this provider has no
  # plugins" — which is how this one sat through the integration column being added.
  *account_configuration_plugins*)             echo "33|9001|einvoicing|comarch|failed|019f-aaa|zatca|revoked" ;;
  *adyen_platform_legal_entity_id*)            : ;;
  *jsonb_array_elements*)
    for k in "organization.legalName=My business" \
             "organization.vatNumber=311268874200003" \
             "organization.registrationNumber=7394826150" \
             "organization.registeredAddress.street=Al Faisaliyyah" \
             "organization.registeredAddress.city=Riyadh" \
             "organization.registeredAddress.postalCode=12896" \
             "organization.registeredAddress.stateOrProvince=Riyadh Province" \
             "_column.country_code=SA" "_column.type=organization"; do
      echo "019f-aaa|${k%%=*}|${k#*=}"
    done
    ;;
  *account_configurations*)
    echo "33|SA"; echo "71|SA"; echo "72|SA"; echo "90|GB"; echo "91|"; echo "92|ES"
    echo "101|IT"; echo "102|IT"
    echo "|SA" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB3/houston"

run3() { PATH="$STUB3:$PATH" node "$JS" "$@" </dev/null >"$TMPDIR_T/o3" 2>"$TMPDIR_T/e3"; echo $?; }
match3() { cat "$TMPDIR_T/o3" "$TMPDIR_T/e3" | grep -qE "$1"; }

expect_match 'mode +: report' "--report selects the report" -- --report --yes
expect_match 'mode +: report' "--scout is an alias" -- --scout --yes

got=$(run3 --report --yes)
# A survey, not a gate: "these providers aren't ready" is its expected finding, so a
# non-zero exit would make every honest run look like a failure.
[ "$got" = "0" ] && ok "the report exits 0 even with blocked providers" \
  || bad "the report exits 0 even with blocked providers" "got $got"
# Every account_configuration with a provider_id — no country filter. The NULL
# provider_id row is the only thing left out, so 8 of the 9 fixture rows.
match3 'Target: .*·  8 provider\(s\)' \
  && ok "…covering every provider, whatever its country" \
  || bad "…covering every provider, whatever its country"
match3 'provider=33 .*migrated .*2 required field' \
  && ok "33: migrated, blocked on its legal entity" \
  || bad "33: migrated, blocked on its legal entity"
match3 'provider=71 .*not migrated .*ready to migrate' \
  && ok "71: not migrated, billing complete = ready" \
  || bad "71: not migrated, billing complete = ready"
match3 'provider=72 .*NO active billing row' \
  && ok "72: no billing row is called out" || bad "72: no billing row is called out"
# building_number / district are present in billing for 71 but are not known to
# survive migrate, so "ready" must carry the caveat rather than claim them.
match3 'propagation unverified|unverified' \
  && ok "…with the building-number/district caveat attached" \
  || bad "…with the building-number/district caveat attached"
# A country with no required-field set must NOT be scored "ready" — nothing was
# required of it, so that word would mean two different things in one column.
match3 'provider=90 .*no e-invoicing rules for GB' \
  && ok "90: GB reported as no_rules, not 'ready'" \
  || bad "90: GB reported as no_rules, not 'ready'"
# And "we cannot tell what is required" is a different answer from "nothing is".
match3 'provider=91 .*NO country on the account configuration' \
  && ok "91: no country is flagged, not treated as no_rules" \
  || bad "91: no country is flagged, not treated as no_rules"
# ── concise is the default ──────────────────────────────────────────────────
# The report answers what was asked and stops. Everything that explains the answer
# rather than being part of it is behind --full, and asking for the short version has
# to actually make it short — these are the lines that used to print unconditionally.
match3 'Surveying' && bad "concise should not narrate its queries" \
  || ok "concise: no progress narration"
match3 'EXCLUDED FROM THIS REPORT|NOT CONFIRMED' \
  && bad "concise should not print the B2B banner" \
  || ok "concise: no Fresha B2B banner"
match3 'is not a problem' \
  && bad "concise should not explain what no_rules means" \
  || ok "concise: no state explainers"
match3 'NOT counted as blocked' \
  && bad "concise should not print the entity-type essay" \
  || ok "concise: no entity-type explainer"
match3 'Read-only: this mode issues SELECTs' \
  && bad "concise should not restate that a read-only mode is read-only" \
  || ok "concise: no read-only footer"
match3 'requires: company name' \
  && bad "concise should not restate each country's required set" \
  || ok "concise: no per-country required-field lines"
# …while still being a report: every provider, and the rollup.
match3 '══ Rollout readiness' && ok "concise: the rollup still prints" \
  || bad "concise: the rollup still prints"
[ "$(grep -cE 'provider=(33|71|72|90|91|92|101|102) ' "$TMPDIR_T/o3" "$TMPDIR_T/e3" | \
    awk -F: '{n+=$2} END {print n}')" -ge 8 ] \
  && ok "concise: every provider is still listed" \
  || bad "concise: every provider is still listed"

# ── --full puts the prose back ──────────────────────────────────────────────
run3 --report --yes --full >/dev/null
# The Fresha B2B account (provider_id = NULL) cannot be covered by a script that keys
# everything on provider_id, so its exclusion is a banner, not a footnote — and it
# must not be dressed up as harmless while the legal-entity question is still open.
match3 'EXCLUDED FROM THIS REPORT: the Fresha B2B account' \
  && ok "--full: the Fresha B2B exclusion gets a banner" \
  || bad "--full: the Fresha B2B exclusion gets a banner"
match3 'NOT CONFIRMED' && ok "…and says the legal-entity question is open" \
  || bad "…and says the legal-entity question is open"
match3 'NOT counted as blocked' && ok "…and explains why 92 is not a blocker" \
  || bad "…and explains why 92 is not a blocker"
match3 'is not a problem' && ok "…and explains no_rules / no_country" \
  || bad "…and explains no_rules / no_country"
# The banner comes BEFORE the data it qualifies, not after. Both lines are on the
# same stream (stdout, since this run has no --json), so line numbers are comparable.
cat "$TMPDIR_T/o3" "$TMPDIR_T/e3" > "$TMPDIR_T/both3"
banner=$(grep -n 'Fresha B2B account' "$TMPDIR_T/both3" | head -1 | cut -d: -f1)
# Anchor on the first mention of any provider rather than a section title, so this
# keeps working if the sections are renamed or reordered again.
roster=$(grep -n 'provider=' "$TMPDIR_T/both3" | head -1 | cut -d: -f1)
[ -n "$banner" ] && [ -n "$roster" ] && [ "$banner" -lt "$roster" ] \
  && ok "…and appears above the roster, not buried under it" \
  || bad "…and appears above the roster, not buried under it" "banner=$banner roster=$roster"
match3 'requires: company name, state province' \
  && ok "…and names the required set that applies to each country" \
  || bad "…and names the required set that applies to each country"

# Back to the concise run for the assertions that hold either way.
run3 --report --yes >/dev/null

# Payments needs no legal entity (providers.fresha_pay keys on provider_id), so the
# gate section must appear even on a pre-rollout run where nothing is migrated —
# gating the whole block on "migrated" made it vanish exactly when it was wanted.
# Either shape counts: the full table (default) or the rollup (--summary).
match3 '(Payments / KYC|KYC / payments) gate' \
  && ok "the payments/KYC gate is reported pre-rollout" \
  || bad "the payments/KYC gate is reported pre-rollout"
# 92, not 71: 71 is SA, and SA has no Adyen KYC, so the gate excludes it entirely (see
# NO_KYC_COUNTRIES). 92 is the un-migrated ES provider with payments enabled.
match3 '92 +enabled' && ok "…with payments status for un-migrated providers" \
  || bad "…with payments status for un-migrated providers"
# The suppression is per country, not global: SA is dropped, the rest of the report is not,
# and the count that shrank says so rather than reading as every provider shown.
match3 '71 +enabled' && bad "SA must not appear in the KYC gate" \
  || ok "SA is excluded from the KYC gate"
match3 'no Adyen KYC in that market' && ok "…and the exclusion is stated, not silent" \
  || bad "…and the exclusion is stated, not silent"
# KYC genuinely does need an entity, so it must say undecidable rather than "failed".
match3 'pending migrate' && ok "…and KYC is 'pending migrate', not a failure" \
  || bad "…and KYC is 'pending migrate', not a failure"

# An ES sole trader has no company_name but does have a person's name. compareFields
# skips company_name for individual entities; assessBilling cannot know the type, so
# this must NOT be scored as a hard blocker.
match3 'provider=92 .*company name absent but a person' \
  && ok "92: ES sole trader flagged as entity-type-unclear" \
  || bad "92: ES sole trader flagged as entity-type-unclear"

# Each e-invoicing country is reported on its own — they have different validators
# and, in practice, different failure modes. The required set each one applies is
# prose (see the --full block above); the sections themselves are not.
match3 '(══|──) KSA \(SA\)' && ok "KSA gets its own section" || bad "KSA gets its own section"
match3 '(══|──) Spain \(ES\)' && ok "Spain gets its own section" || bad "Spain gets its own section"
match3 '(══|──) Italy \(IT\)' && ok "Italy gets its own section" || bad "Italy gets its own section"
match3 'provider=102 .*1 required field' \
  && ok "…and IT's missing tax_number is a blocker" \
  || bad "…and IT's missing tax_number is a blocker"
match3 'provider=101 .*ready to migrate' \
  && ok "…while a complete IT provider is ready" \
  || bad "…while a complete IT provider is ready"
# The full comparison table prints for every provider, not just under --detail.
match3 'LEGAL ENTITY \(fields jsonb\)' \
  && ok "every provider gets the five-column field table" \
  || bad "every provider gets the five-column field table"
match3 'organization\.registeredAddress\.buildingNumber = ∅' \
  && ok "…naming the key migrate has to fill, even with no entity yet" \
  || bad "…naming the key migrate has to fill, even with no entity yet"

# --countries narrows the report. Fixture is SA 3, IT 2, ES 1, GB 1, none 1.
# TWO countries, so the cut is still worth stating: the totals below cover four of the
# eight providers, and an unstated exclusion would read as the whole namespace.
got=$(run3 --report --yes --countries SA,ES --summary)
[ "$got" = "0" ] && ok "--countries runs clean" || bad "--countries runs clean" "got $got"
# The reads always cover every country (so the refine loop can widen without
# re-querying), so the filter line is what reports the cut.
match3 '— 4 of 8 provider\(s\) excluded by it' && ok "…and cuts the other countries" \
  || bad "…and cuts the other countries"
match3 'Country filter: SA, ES' && ok "…stating the filter it applied" \
  || bad "…stating the filter it applied"

# ── one country means one country ───────────────────────────────────────────
# Asking for Italy and being handed the namespace's other countries — a B2B banner,
# an ALL roll-up, a count of what was excluded — is the thing this rule exists to
# stop. The report is about IT, so nothing may name another country.
got=$(run3 --report --yes -C IT)
[ "$got" = "0" ] && ok "one country: runs clean" || bad "one country: runs clean" "got $got"
match3 'Target: .*Italy \(IT\).*·  2 provider\(s\)' \
  && ok "…and the header names the country and its count" \
  || bad "…and the header names the country and its count"
match3 '^  ALL ' && bad "the ALL roll-up duplicates the single country block" \
  || ok "…no ALL roll-up — the one country block IS the total"
match3 'Country filter:' && bad "…should not count what it excluded" \
  || ok "…no exclusion count for the other countries"
match3 'EXCLUDED FROM THIS REPORT|Fresha B2B' \
  && bad "…should not raise the B2B account" \
  || ok "…no Fresha B2B banner"
match3 'e-invoicing: |other countr' && bad "…should not break down other countries" \
  || ok "…no cross-country breakdown"
match3 '(══|──) (KSA|Spain|GB)' && bad "…should not render another country's section" \
  || ok "…and no other country's section"
match3 'provider=101|provider=102' && ok "…while still reporting both IT providers" \
  || bad "…while still reporting both IT providers"
# --full restores the prose but must NOT restore the other countries.
run3 --report --yes -C IT --full >/dev/null
match3 'requires: company name, state province' \
  && ok "one country + --full: the prose comes back" \
  || bad "one country + --full: the prose comes back"
match3 '^  ALL |Fresha B2B' \
  && bad "--full must not override the single-country rule" \
  || ok "…but --full does not bring the other countries back"

# Reporting on fewer countries than asked for, silently, is the thing to avoid — so a
# code that matched nothing is named even though the result is a single-country report.
run3 --report --yes -C SA,XX --summary >/dev/null
match3 'no account configuration has XX' && ok "…and names a country code that matched nothing" \
  || bad "…and names a country code that matched nothing"
# A country code that matches nothing can only be a typo (the prompt validates), so it
# is a usage error — exit 2 — not an empty report and a clean exit.
got=$(run3 --report --yes -C XX --summary)
[ "$got" = "2" ] && ok "…and a country matching nothing is a usage error" \
  || bad "…and a country matching nothing is a usage error" "got $got"

# The send path routes every country through Common.LegalEntityBillingDetails, whose
# @required_fields includes company_name — so SA needs it even though Comarch's own
# onboarding set does not list it. Verified against app-accounting-documents.
run3 --report --yes -C SA --summary --full >/dev/null
match3 'requires: company name, state province' \
  && ok "SA requires company name (send path via Common)" \
  || bad "SA requires company name (send path via Common)"
match3 'required by the SEND path' && ok "…and the output says which path demands it" \
  || bad "…and the output says which path demands it"

# ── the Markdown export mirrors the screen ──────────────────────────────────
# A concise run must not write a verbose file: the explainer sections are exactly what
# the reader said they did not want, and the export is the artefact that gets shared.
MD_C="$TMPDIR_T/concise.md"; MD_F="$TMPDIR_T/full.md"
run3 --report --yes --md "$MD_C" >/dev/null
run3 --report --yes --full --md "$MD_F" >/dev/null
grep -q '## What this report is' "$MD_F" \
  && ok "--full --md: the export carries the explainer" \
  || bad "--full --md: the export carries the explainer"
grep -q '## What this report is' "$MD_C" \
  && bad "a concise run wrote a verbose export" \
  || ok "concise --md: the explainer is dropped"
grep -q 'Excluded from this report' "$MD_C" \
  && bad "a concise export should not carry the B2B callout" \
  || ok "…along with the B2B callout and Not-covered section"
# Prose only. A shorter report that also drops a provider is a broken report.
for p in 33 71 72 90 91 92 101 102; do
  grep -q "| $p |" "$MD_C" || bad "concise export lost provider $p"
done
ok "…but every provider row survives in both"
grep -q 'Re-run with `--full`' "$MD_C" \
  && ok "…and the concise export says how to get the caveats back" \
  || bad "…and the concise export says how to get the caveats back"

# The prompts. Every other assertion here runs without a terminal, which is exactly
# the condition that skips them — so this block needs a real pty. Skipped, loudly, if
# `expect` isn't installed rather than silently passing.
if command -v expect >/dev/null 2>&1; then
  cat > "$TMPDIR_T/drive.exp" <<'EXP'
set timeout 20
set env(PATH) "$env(STUB3):$env(PATH)"
# A pty means colour is ON, which would put escape sequences between a label and its
# value and break every adjacency match below. The script honours NO_COLOR.
set env(NO_COLOR) "1"
spawn node $env(JS) --report -n eng-orion --summary
expect "Read from these databases?"                { send "1\r" }
expect "Which providers should the report cover?"  { send "1\r" }
# The verbosity question sits here — before the survey, because concise also means no
# progress lines and by the first query it is too late to choose. 2 = Full, so the
# prose assertions below have something to match.
expect "How much report?"                          { send "2\r" }
expect "Which countries?"                          { send "4\r" }
expect "to exclude"                                { send "GB\r" }
expect "Which conditions?"                         { send "3\r" }
expect "Export the full report as Markdown?"       { send "n\r" }
expect eof
EXP
  STUB3="$STUB3" JS="$JS" expect -f "$TMPDIR_T/drive.exp" >"$TMPDIR_T/tty.out" 2>&1
  tty_match() { grep -qE "$1" "$TMPDIR_T/tty.out"; }

  tty_match 'Which providers should the report cover' \
    && ok "prompts for the provider list" || bad "prompts for the provider list"
  # Concise is the default, so the prompt has to exist for anyone who wants the rest.
  tty_match 'How much report' && ok "prompts for how much report" \
    || bad "prompts for how much report"
  tty_match 'Concise . the numbers and the tables' \
    && ok "…offering concise as the default" || bad "…offering concise as the default"
  tty_match 'Full . every caveat' && ok "…and full as the opt-in" \
    || bad "…and full as the opt-in"
  # The country options are built from the data, so they carry real counts and the
  # exclude list can be checked against what's actually there.
  tty_match 'all . countries' && ok "prompts for countries, with counts" \
    || bad "prompts for countries, with counts"
  tty_match 'only the e-invoicing countries' \
    && ok "…offering the e-invoicing subset" || bad "…offering the e-invoicing subset"
  tty_match 'everything EXCEPT countries I name' \
    && ok "…and an exclude option" || bad "…and an exclude option"
  tty_match 'Country filter: .*GB' && bad "GB should have been excluded, not included" \
    || ok "excluding GB removes it from the filter"
  tty_match 'Which conditions' && ok "prompts for the condition" || bad "prompts for the condition"
  tty_match 'only hard blockers' && ok "…offering hard blockers only" \
    || bad "…offering hard blockers only"
  tty_match 'Condition filter: no_billing, blocked' \
    && ok "…and applies the chosen condition" || bad "…and applies the chosen condition"
  # Whatever a filter removes has to be stated, or the totals read as the whole set.
  tty_match 'hidden by it:' && ok "…naming what the filter hid" || bad "…naming what the filter hid"

  # The refine loop: re-filter without re-querying. The fixture's houston counts its
  # own invocations, so this proves the second and third renders issued no new SQL.
  cat > "$TMPDIR_T/loop.exp" <<'EXP'
set timeout 25
set env(PATH) "$env(STUB3):$env(PATH)"
set env(NO_COLOR) "1"
spawn node $env(JS) --report -n eng-orion --summary
expect "Read from these databases?"               { send "1\r" }
expect "Which providers should the report cover?" { send "1\r" }
# 1 = Concise, which is also what a bare Enter would pick. The roll-up and the refine
# loop are data, not prose, so both must survive it.
expect "How much report?"                         { send "1\r" }
expect "Which countries?"                         { send "2\r" }
expect "Which conditions?"                        { send "3\r" }
expect "Refine the report?"                       { send "3\r" }
expect "Which conditions?"                        { send "1\r" }
expect "Refine the report?"                       { send "4\r" }
expect "Refine the report?"                       { send "1\r" }
expect "Export the full report as Markdown?"      { send "n\r" }
expect eof
EXP
  : > "$TMPDIR_T/sqlcount"
  STUB3="$STUB3" JS="$JS" SQLCOUNT="$TMPDIR_T/sqlcount" \
    expect -f "$TMPDIR_T/loop.exp" >"$TMPDIR_T/loop.out" 2>&1
  loop_match() { grep -qE "$1" "$TMPDIR_T/loop.out"; }

  loop_match 'Refine the report' && ok "offers a refine menu after rendering" \
    || bad "offers a refine menu after rendering"
  [ "$(grep -c 'Refine the report' "$TMPDIR_T/loop.out")" -ge 3 ] \
    && ok "…and keeps offering it until you're done" \
    || bad "…and keeps offering it until you're done"
  # Composed filters must not double-count the first one's cut.
  loop_match 'showing . of . provider\(s\) in those countries' \
    && ok "…counting conditions against the country-filtered set" \
    || bad "…counting conditions against the country-filtered set"
  # "Clear both filters" has to widen back to everything, which is only possible
  # because the reads were never narrowed by country.
  [ "$(grep -cE '^  ALL ' "$TMPDIR_T/loop.out")" -ge 3 ] \
    && ok "…re-rendering the rollup each time" \
    || bad "…re-rendering the rollup each time"
  loop_match '^  ALL +8 ' && ok "clearing the filters widens back to every provider" \
    || bad "clearing the filters widens back to every provider"
  # The prose toggle is in the menu too, so a concise run can expand in place without
  # re-running the whole thing.
  loop_match 'Show the caveats and footnotes' \
    && ok "…and the refine menu can turn the prose on" \
    || bad "…and the refine menu can turn the prose on"
  # Re-filtering is a display concern: no query may run after the first render.
  reads=$(grep -c . "$TMPDIR_T/sqlcount" 2>/dev/null || echo 0)
  first=$(grep -n 'Refine the report' "$TMPDIR_T/loop.out" | head -1 | cut -d: -f1)
  after=$(tail -n "+$first" "$TMPDIR_T/loop.out" | grep -c 'houston psql')
  [ "$after" = "0" ] && ok "…and issues no further SQL while refining" \
    || bad "…and issues no further SQL while refining" "$after queries after the first render"
else
  bad "SKIPPED: expect not installed — the interactive prompts are unverified"
fi

run3 --report --yes >/dev/null
PATH="$STUB3:$PATH" node "$JS" --report --yes --json </dev/null >"$TMPDIR_T/j3.out" 2>/dev/null
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fail = (m) => { console.error(m); process.exit(1); };
  if (d.verdict !== "REPORTED") fail(`verdict ${d.verdict}, want REPORTED`);
  if (d.exit !== 0) fail(`exit ${d.exit}, want 0`);
  if (d.tally.total !== 8) fail(`tally.total ${d.tally.total}, want 8`);
  if (d.tally.no_rules !== 1) fail(`tally.no_rules ${d.tally.no_rules}, want 1`);
  if (d.tally.no_country !== 1) fail(`tally.no_country ${d.tally.no_country}, want 1`);
  if (d.tally.ready !== 2) fail(`tally.ready ${d.tally.ready}, want 2 (GB must not count)`);
  if (d.tally.entity_type_unclear !== 1) fail("the ES sole trader is not tallied");
  if (d.tally.blocked !== 2) fail(`tally.blocked ${d.tally.blocked}, want 2 (92 must not count)`);
  // Payments for everyone in a market the gate applies to; KYC only where an entity
  // exists. 5 of the 8, because 33/71/72 are SA and SA has no Adyen KYC at all.
  if (d.kyc.length !== 5) fail(`kyc rows ${d.kyc.length}, want 5 (SA excluded)`);
  if (d.kyc.some((k) => ["33", "71", "72"].includes(k.provider_id))) {
    fail("SA providers must not be gated");
  }
  const k92 = d.kyc.find((k) => k.provider_id === "92");
  if (k92.payments !== "enabled") fail("92 payments not read");
  if (k92.has_legal_entity !== false) fail("92 should have no legal entity");
  if (k92.gate !== "pending_migrate") fail(`92 gate ${k92.gate}, want pending_migrate`);
  if (d.scope.by_country.GB !== 1) fail("GB missing from scope.by_country");
  if (d.scope.by_country.IT !== 2) fail("IT missing from scope.by_country");
  if (d.scope.account_configurations_without_provider_id !== 1) fail("NULL provider_id not counted");
  // The machine payload states how it was shaped, so a consumer can tell a slice from
  // a full sweep without diffing counts.
  if (d.report.verbose !== false) fail("report.verbose should default to false");
  if (d.report.countries !== null) fail("report.countries should be null unfiltered");
  const by = Object.fromEntries(d.providers.map((p) => [p.provider_id, p]));
  // The two shapes are mutually exclusive: a migrated provider carries a real
  // comparison, an un-migrated one carries a billing-side assessment. Confusing
  // the two would let a caller read "ready" as "checked against an entity".
  if (!by["33"].comparison || by["33"].billing_readiness) fail("33 should carry comparison only");
  if (by["71"].comparison || !by["71"].billing_readiness) fail("71 should carry readiness only");
  if (by["72"].billing_readiness.has_billing_row !== false) fail("72 should have no billing row");
' "$TMPDIR_T/j3.out" \
  && ok "the payload keeps the two shapes distinct" \
  || bad "the payload keeps the two shapes distinct"

# scope must describe what was reported, not the namespace — reading scope alongside
# providers[] should tell one story, and it used to tell two under a filter.
PATH="$STUB3:$PATH" node "$JS" --report --yes --json -C IT </dev/null \
  >"$TMPDIR_T/j4.out" 2>/dev/null
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fail = (m) => { console.error(m); process.exit(1); };
  if (d.scope.in_scope !== 2) fail(`scope.in_scope ${d.scope.in_scope}, want 2`);
  if (Object.keys(d.scope.by_country).join() !== "IT") {
    fail(`scope.by_country ${JSON.stringify(d.scope.by_country)}, want IT only`);
  }
  if (d.scope.surveyed !== 8) fail(`scope.surveyed ${d.scope.surveyed}, want 8`);
  if (d.providers.length !== 2) fail(`providers ${d.providers.length}, want 2`);
  if (d.report.countries.join() !== "IT") fail("report.countries should name IT");
' "$TMPDIR_T/j4.out" \
  && ok "…and scope narrows to the country that was asked for" \
  || bad "…and scope narrows to the country that was asked for"

echo
echo "── interactive default is intact ──────────────────────"
# With no flags and no terminal the script must ask for nothing and refuse
# cleanly — it must not hang waiting on a prompt it can never receive.
expect_exit 2 "no flags, no terminal: refuses instead of hanging" --
expect_match 'No mode given' "…and says a mode flag is needed" --

echo
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
