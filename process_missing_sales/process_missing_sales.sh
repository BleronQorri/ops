#!/usr/bin/env bash
#
# process_missing_sales — backfill accounting documents for sales that never
# produced an invoice / credit note.
#
# Pipeline (production):
#   1. Export the given sales to a CSV via `houston psql production shedul`
#      (\copy). Filtered by provider_id + an explicit list of sale ids.
#   2. Upload the CSV to
#      s3://fresha-accounting-documents-production/process_missing_sales_events_backfill/
#      via `houston aws-shell <profile> -- aws s3 cp`.
#   3. Run the `process_missing_sales_events` houston task against
#      `accounting-documents-web`, passing PROVIDER_ID + S3_KEY. This step is
#      GATED behind an explicit typed confirmation.
#
# The CSV column order is dictated by the task's parser
# (ProcessMissingSalesEventsTask.parse_row/1) — do NOT reorder the SELECT.
#
# Usage:
#   ./pms <provider_id> <sale_id1,sale_id2,...> [flags]
#
# The task always runs with FORCE unset: any sale that already has a document
# is skipped by the task (InvoiceProcessingRouter).
#
# Flags:
#   --profile <name>     AWS profile for the S3 upload
#                        (default: fresha-production-developer).
#   --keep-csv           Keep the generated CSV on disk (prints the path).
#   --dry-run            Do everything up to (and including) the S3 upload,
#                        print the exact task command, but do NOT run the task.
#   --skip-upload        Only generate the CSV (implies --dry-run, --keep-csv).
#   -h, --help           Show this help.

set -euo pipefail

BUCKET="fresha-accounting-documents-production"
PREFIX="process_missing_sales_events_backfill"
SERVICE="accounting-documents-web"
TASK="process_missing_sales_events"
DB_ENV="production"
DB_NAME="shedul"

# --- args -------------------------------------------------------------------
PROVIDER_ID=""
SALE_IDS_RAW=""
# team-orion role has PutObject on the accounting-documents bucket;
# fresha-production-developer does not.
PROFILE="fresha-production-team-orion"
KEEP_CSV=0
DRY_RUN=0
SKIP_UPLOAD=0

positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)      PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --keep-csv)     KEEP_CSV=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --skip-upload)  SKIP_UPLOAD=1; DRY_RUN=1; KEEP_CSV=1; shift ;;
    -h|--help)      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             echo "ERROR: unknown flag: $1" >&2; exit 1 ;;
    *)              positional+=("$1"); shift ;;
  esac
done

PROVIDER_ID="${positional[0]:-}"
SALE_IDS_RAW="${positional[1]:-}"

# --- interactive prompts for anything not passed on the CLI ------------------
if [[ -z "$PROVIDER_ID" ]]; then
  read -r -p "provider_id: " PROVIDER_ID
fi
if [[ -z "$PROVIDER_ID" ]]; then
  echo "ERROR: provider_id is required." >&2
  exit 1
fi
if ! [[ "$PROVIDER_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: provider_id must be numeric, got '$PROVIDER_ID'." >&2
  exit 1
fi

if [[ -z "$SALE_IDS_RAW" ]]; then
  read -r -p "sale ids (comma-separated): " SALE_IDS_RAW
fi
if [[ -z "$SALE_IDS_RAW" ]]; then
  echo "ERROR: at least one sale id is required." >&2
  exit 1
fi

# --- build the quoted sale-id IN list ---------------------------------------
# Split on commas, trim whitespace, drop empties, single-quote each id.
# Quoting keeps this correct whether sales.id is bigint or uuid (Postgres casts
# the unknown-typed literal to the column type).
IFS=',' read -r -a _raw_ids <<< "$SALE_IDS_RAW"
in_list=""
count=0
for raw in "${_raw_ids[@]}"; do
  id="$(echo "$raw" | tr -d '[:space:]')"
  [[ -z "$id" ]] && continue
  # basic sanity: no quotes / semicolons sneaking into the SQL
  if [[ "$id" == *"'"* || "$id" == *";"* ]]; then
    echo "ERROR: illegal character in sale id '$id'." >&2
    exit 1
  fi
  [[ -n "$in_list" ]] && in_list+=","
  in_list+="'$id'"
  count=$((count + 1))
done

if [[ "$count" -eq 0 ]]; then
  echo "ERROR: no sale ids parsed from '$SALE_IDS_RAW'." >&2
  exit 1
fi

# --- file / key names -------------------------------------------------------
# Filename MUST contain provider_id — the task validates S3_KEY contains it.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${PROVIDER_ID}_${STAMP}.csv"
S3_KEY="${PREFIX}/${FILENAME}"
S3_URI="s3://${BUCKET}/${S3_KEY}"

WORKDIR="$(mktemp -d)"
CSV_PATH="${WORKDIR}/${FILENAME}"
SQL_PATH="${WORKDIR}/export.sql"

cleanup() {
  if [[ "$KEEP_CSV" -eq 0 ]]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

# confirm <prompt> — y to proceed, anything else aborts.
confirm() {
  local ans
  read -r -p "$1 (y to proceed, anything else aborts): " ans
  if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
}

# --- build the \copy SQL ----------------------------------------------------
# Column order matches ProcessMissingSalesEventsTask.parse_row/1 exactly.
# psql's \copy is a meta-command that must live on a SINGLE physical line, so
# the whole query is emitted as one line (newlines break it with
# "\copy: parse error at end of line").
QUERY="WITH ids AS ( \
  SELECT id FROM sales \
  WHERE provider_id = '${PROVIDER_ID}' AND id IN (${in_list}) \
) \
SELECT \
  s.id AS s_id, s.provider_id AS s_provider_id, s.receipt_number AS s_receipt_number, \
  s.created_at AS s_created_at, s.total_net AS s_total_net, s.total_gross AS s_total_gross, \
  s.refund_sale_id AS s_refund_sale_id, s.original_sale_id AS s_original_sale_id, \
  si.id AS si_id, si.name AS si_name, si.quantity AS si_quantity, si.unit_gross AS si_unit_gross, \
  si.total_net AS si_total_net, si.total_gross AS si_total_gross, \
  sit.id AS sit_id, sit.tax_rate AS sit_tax_rate, sit.tax_name AS sit_tax_name, sit.value AS sit_value, \
  asch.id AS asc_id, asch.name AS asc_name, asch.value_gross AS asc_value_gross, asch.value_net AS asc_value_net, \
  asct.id AS asct_id, asct.tax_rate_id AS asct_tax_rate_id, asct.tax_rate AS asct_tax_rate, \
  asct.tax_name AS asct_tax_name, asct.value AS asct_value, \
  os.id AS os_original_sale_id, os.receipt_number AS os_receipt_number, \
  rfs.id AS rfs_refund_sale_id, rfs.receipt_number AS rfs_receipt_number, rfs.created_at AS rfs_refunded_at \
FROM ids \
JOIN sales s ON s.id = ids.id \
LEFT JOIN sale_items si ON si.sale_id = s.id \
LEFT JOIN sale_item_taxes sit ON sit.sale_item_id = si.id \
LEFT JOIN applied_service_charges asch ON asch.sale_id = s.id \
LEFT JOIN applied_service_charge_taxes asct ON asct.applied_service_charge_id = asch.id \
LEFT JOIN sales rfs ON rfs.id = s.refund_sale_id \
LEFT JOIN sales os ON os.id = s.original_sale_id \
ORDER BY s.id"

# Collapse any residual whitespace runs, then write the single-line \copy.
QUERY="$(echo "$QUERY" | tr -s '[:space:]' ' ')"
printf "\\\\copy (%s) TO '%s' WITH CSV HEADER\n" "$QUERY" "$CSV_PATH" > "$SQL_PATH"

# --- banner -----------------------------------------------------------------
echo
echo "============================================================"
echo "  process_missing_sales"
echo "  provider_id : $PROVIDER_ID"
echo "  sale ids    : $count sale(s)"
echo "  db          : houston psql $DB_ENV $DB_NAME"
echo "  s3          : $S3_URI"
echo "  task        : houston task run $SERVICE $TASK"
echo "  note        : sales with an existing document are skipped by the task"
[[ $DRY_RUN -eq 1 ]] && echo "  MODE        : DRY RUN (task will NOT be run)"
echo "============================================================"
echo

# --- step 1: export CSV -----------------------------------------------------
echo "### Step 1 — export sales to CSV (read-only) ###"
echo "Will run: houston psql $DB_ENV $DB_NAME -- -f <sql>"
echo "SQL to run:"
sed 's/^/    /' "$SQL_PATH"
echo
confirm "Run the export now?"
houston psql "$DB_ENV" "$DB_NAME" -- -f "$SQL_PATH"

if [[ ! -s "$CSV_PATH" ]]; then
  echo "ERROR: CSV was not written or is empty: $CSV_PATH" >&2
  exit 1
fi

data_rows=$(( $(wc -l < "$CSV_PATH") - 1 ))
echo "CSV written: $CSV_PATH ($data_rows data row(s))"
if [[ "$data_rows" -le 0 ]]; then
  echo "ERROR: query returned no rows — check provider_id / sale ids." >&2
  exit 1
fi
echo "Header + first rows:"
head -n 4 "$CSV_PATH" | sed 's/^/    /'
echo

if [[ $SKIP_UPLOAD -eq 1 ]]; then
  echo "--skip-upload set. CSV kept at: $CSV_PATH"
  echo "Would upload to: $S3_URI"
  exit 0
fi

# --- step 2: upload to S3 ---------------------------------------------------
echo "### Step 2 — upload CSV to S3 ###"
echo "Will run: houston aws-shell $PROFILE -- aws s3 cp <csv> $S3_URI"
confirm "Upload the CSV to S3 now?"
houston aws-shell "$PROFILE" -- aws s3 cp "$CSV_PATH" "$S3_URI"
echo "Uploaded: $S3_URI"
echo

# --- step 3: run the task (gated) ------------------------------------------
TASK_CMD=(houston task run "$SERVICE" "$TASK"
  -p "PROVIDER_ID=${PROVIDER_ID}"
  -p "S3_KEY=${S3_KEY}"
  -w)

echo "### Step 3 — run the backfill task ###"
echo "Exact command:"
printf '    %q ' "${TASK_CMD[@]}"; echo; echo

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[DRY RUN] Not running the task. Re-run without --dry-run to execute."
  echo "CSV S3_KEY: $S3_KEY"
  exit 0
fi

read -r -p "Run this PRODUCTION task now? Type 'yes' to proceed: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted. CSV already uploaded at $S3_URI (S3_KEY: $S3_KEY)."
  exit 1
fi

"${TASK_CMD[@]}"
echo
echo "✓ process_missing_sales complete (provider $PROVIDER_ID, $count sale(s))."
