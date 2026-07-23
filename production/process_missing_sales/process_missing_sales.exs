#!/usr/bin/env elixir

# process_missing_sales — backfill accounting documents for sales that never
# produced an invoice / credit note.
#
# Pipeline (production), each step gated by a confirmation:
#   1. Export the given sales to a CSV via `houston psql production shedul` (\copy),
#      filtered by provider_id + an explicit list of sale ids.
#   2. Upload the CSV to
#      s3://fresha-accounting-documents-production/process_missing_sales_events_backfill/
#      via `houston aws-shell <profile> -- aws s3 cp`.
#   3. Run the `process_missing_sales_events` houston task against
#      `accounting-documents-web`, passing PROVIDER_ID + S3_KEY. GATED behind a
#      typed "yes".
#
# The CSV column order is dictated by the task's parser
# (ProcessMissingSalesEventsTask.parse_row/1) — do NOT reorder the SELECT.
#
# The task always runs with FORCE unset: any sale that already has a document is
# skipped by the task (InvoiceProcessingRouter).
#
# Usage:
#   ./process_missing_sales.exs <provider_id> <sale_id1,sale_id2,...> [flags]
#
# Flags:
#   --profile <name>   AWS profile for the S3 upload (default: fresha-production-team-orion).
#   --keep-csv         Keep the generated CSV on disk (prints the path).
#   --dry-run          Do everything up to (and including) the S3 upload, print the
#                      exact task command, but do NOT run the task.
#   --skip-upload      Only generate the CSV (implies --dry-run, --keep-csv).
#   -h, --help         Show this help.

defmodule ProcessMissingSales do
  @moduledoc false

  @check "✅"
  @cross "❌"

  @bucket "fresha-accounting-documents-production"
  @prefix "process_missing_sales_events_backfill"
  @service "accounting-documents-web"
  @task "process_missing_sales_events"
  @db_env "production"
  @db_name "shedul"
  # team-orion role has PutObject on the accounting-documents bucket;
  # fresha-production-developer does not.
  @default_profile "fresha-production-team-orion"

  def run(argv) do
    if "--help" in argv or "-h" in argv, do: (usage(); System.halt(0))

    opts = parse_args(argv)

    provider_id = resolve_provider_id(opts.provider_id)
    sale_ids = resolve_sale_ids(opts.sale_ids_raw)
    in_list = build_in_list(sale_ids)

    stamp = DateTime.utc_now() |> Calendar.strftime("%Y%m%dT%H%M%SZ")
    # Filename MUST contain provider_id — the task validates S3_KEY contains it.
    filename = "#{provider_id}_#{stamp}.csv"
    s3_key = "#{@prefix}/#{filename}"
    s3_uri = "s3://#{@bucket}/#{s3_key}"

    workdir = Path.join(System.tmp_dir!(), "pms_#{stamp}")
    File.mkdir_p!(workdir)
    csv_path = Path.join(workdir, filename)
    sql_path = Path.join(workdir, "export.sql")

    try do
      write_copy_sql(sql_path, csv_path, provider_id, in_list)

      banner(provider_id, length(sale_ids), s3_uri, opts.dry_run?)

      # --- step 1: export CSV -------------------------------------------------
      IO.puts(hl("### Step 1 — export sales to CSV (read-only) ###"))
      IO.puts("Will run: houston psql #{@db_env} #{@db_name} -- -f <sql>")
      IO.puts("SQL to run:")
      File.read!(sql_path) |> indent() |> IO.puts()
      IO.puts("")
      confirm!("Run the export now?")

      houston!(["psql", @db_env, @db_name, "--", "-f", sql_path])

      unless File.exists?(csv_path) and File.stat!(csv_path).size > 0 do
        die("CSV was not written or is empty: #{csv_path}")
      end

      data_rows = count_data_rows(csv_path)
      IO.puts("CSV written: #{csv_path} (#{data_rows} data row(s))")

      if data_rows <= 0 do
        die("query returned no rows — check provider_id / sale ids.")
      end

      IO.puts("Header + first rows:")
      preview_csv(csv_path) |> IO.puts()
      IO.puts("")

      if opts.skip_upload? do
        IO.puts("--skip-upload set. CSV kept at: #{csv_path}")
        IO.puts("Would upload to: #{s3_uri}")
        System.halt(0)
      end

      # --- step 2: upload to S3 ----------------------------------------------
      IO.puts(hl("### Step 2 — upload CSV to S3 ###"))
      IO.puts("Will run: houston aws-shell #{opts.profile} -- aws s3 cp <csv> #{s3_uri}")
      confirm!("Upload the CSV to S3 now?")

      houston!(["aws-shell", opts.profile, "--", "aws", "s3", "cp", csv_path, s3_uri])
      IO.puts("Uploaded: #{s3_uri}")
      IO.puts("")

      # --- step 3: run the task (gated) --------------------------------------
      task_args = [
        "task", "run", @service, @task,
        "-p", "PROVIDER_ID=#{provider_id}",
        "-p", "S3_KEY=#{s3_key}",
        "-w"
      ]

      IO.puts(hl("### Step 3 — run the backfill task ###"))
      IO.puts("Exact command:")
      IO.puts(indent("houston " <> Enum.join(task_args, " ")))
      IO.puts("")

      if opts.dry_run? do
        IO.puts(warn("[DRY RUN] Not running the task. Re-run without --dry-run to execute."))
        IO.puts("CSV S3_KEY: #{s3_key}")
        System.halt(0)
      end

      case prompt_value("Run this PRODUCTION task now? Type 'yes' to proceed: ") do
        "yes" ->
          houston!(task_args)
          IO.puts("")
          IO.puts(ok("#{@check} process_missing_sales complete (provider #{provider_id}, #{length(sale_ids)} sale(s))."))

        _ ->
          IO.puts("Aborted. CSV already uploaded at #{s3_uri} (S3_KEY: #{s3_key}).")
          System.halt(1)
      end
    after
      unless opts.keep_csv?, do: File.rm_rf(workdir)
    end
  end

  # --- arg parsing -----------------------------------------------------------

  defp parse_args(argv) do
    init = %{
      profile: @default_profile,
      keep_csv?: false,
      dry_run?: false,
      skip_upload?: false,
      positional: []
    }

    opts = do_parse(argv, init)
    [provider_id, sale_ids_raw] = Enum.take(Enum.reverse(opts.positional) ++ [nil, nil], 2)

    opts
    |> Map.put(:provider_id, provider_id)
    |> Map.put(:sale_ids_raw, sale_ids_raw)
  end

  defp do_parse([], acc), do: acc
  defp do_parse(["--profile", val | rest], acc), do: do_parse(rest, %{acc | profile: val})
  defp do_parse(["--keep-csv" | rest], acc), do: do_parse(rest, %{acc | keep_csv?: true})
  defp do_parse(["--dry-run" | rest], acc), do: do_parse(rest, %{acc | dry_run?: true})

  defp do_parse(["--skip-upload" | rest], acc),
    do: do_parse(rest, %{acc | skip_upload?: true, dry_run?: true, keep_csv?: true})

  defp do_parse(["--profile"], _acc), do: die("--profile needs a value")
  defp do_parse(["-" <> _ = flag | _rest], _acc), do: die("unknown flag: #{flag}")
  defp do_parse([pos | rest], acc), do: do_parse(rest, %{acc | positional: [pos | acc.positional]})

  # --- input resolution + validation -----------------------------------------

  defp resolve_provider_id(nil), do: resolve_provider_id(prompt_value("provider_id: "))
  defp resolve_provider_id(""), do: die("provider_id is required.")

  defp resolve_provider_id(raw) do
    id = String.trim(raw)
    if id == "", do: die("provider_id is required.")
    unless id =~ ~r/^[0-9]+$/, do: die("provider_id must be numeric, got '#{id}'.")
    id
  end

  defp resolve_sale_ids(nil), do: resolve_sale_ids(prompt_value("sale ids (comma-separated): "))
  defp resolve_sale_ids(""), do: die("at least one sale id is required.")

  defp resolve_sale_ids(raw) do
    ids =
      raw
      |> String.split(",")
      |> Enum.map(&String.replace(&1, ~r/\s/, ""))
      |> Enum.reject(&(&1 == ""))

    if ids == [], do: die("no sale ids parsed from '#{raw}'.")

    Enum.each(ids, fn id ->
      # basic sanity: no quotes / semicolons sneaking into the SQL
      if String.contains?(id, "'") or String.contains?(id, ";") do
        die("illegal character in sale id '#{id}'.")
      end
    end)

    ids
  end

  # Single-quote each id. Quoting keeps this correct whether sales.id is bigint or
  # uuid (Postgres casts the unknown-typed literal to the column type).
  defp build_in_list(ids), do: Enum.map_join(ids, ",", &"'#{&1}'")

  # --- SQL -------------------------------------------------------------------

  # Column order matches ProcessMissingSalesEventsTask.parse_row/1 exactly.
  # psql's \copy is a meta-command that must live on a SINGLE physical line, so
  # the whole query is emitted as one collapsed line.
  defp write_copy_sql(sql_path, csv_path, provider_id, in_list) do
    query = """
    WITH ids AS (
      SELECT id FROM sales
      WHERE provider_id = '#{provider_id}' AND id IN (#{in_list})
    )
    SELECT
      s.id AS s_id, s.provider_id AS s_provider_id, s.receipt_number AS s_receipt_number,
      s.created_at AS s_created_at, s.total_net AS s_total_net, s.total_gross AS s_total_gross,
      s.refund_sale_id AS s_refund_sale_id, s.original_sale_id AS s_original_sale_id,
      si.id AS si_id, si.name AS si_name, si.quantity AS si_quantity, si.unit_gross AS si_unit_gross,
      si.total_net AS si_total_net, si.total_gross AS si_total_gross,
      sit.id AS sit_id, sit.tax_rate AS sit_tax_rate, sit.tax_name AS sit_tax_name, sit.value AS sit_value,
      asch.id AS asc_id, asch.name AS asc_name, asch.value_gross AS asc_value_gross, asch.value_net AS asc_value_net,
      asct.id AS asct_id, asct.tax_rate_id AS asct_tax_rate_id, asct.tax_rate AS asct_tax_rate,
      asct.tax_name AS asct_tax_name, asct.value AS asct_value,
      os.id AS os_original_sale_id, os.receipt_number AS os_receipt_number,
      rfs.id AS rfs_refund_sale_id, rfs.receipt_number AS rfs_receipt_number, rfs.created_at AS rfs_refunded_at
    FROM ids
    JOIN sales s ON s.id = ids.id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN sale_item_taxes sit ON sit.sale_item_id = si.id
    LEFT JOIN applied_service_charges asch ON asch.sale_id = s.id
    LEFT JOIN applied_service_charge_taxes asct ON asct.applied_service_charge_id = asch.id
    LEFT JOIN sales rfs ON rfs.id = s.refund_sale_id
    LEFT JOIN sales os ON os.id = s.original_sale_id
    ORDER BY s.id
    """

    one_line = query |> String.replace(~r/\s+/, " ") |> String.trim()
    File.write!(sql_path, "\\copy (#{one_line}) TO '#{csv_path}' WITH CSV HEADER\n")
  end

  defp count_data_rows(csv_path) do
    lines = csv_path |> File.stream!() |> Enum.count()
    max(lines - 1, 0)
  end

  defp preview_csv(csv_path) do
    csv_path
    |> File.stream!()
    |> Enum.take(4)
    |> Enum.map_join("", &("    " <> &1))
    |> String.trim_trailing()
  end

  # --- houston shell-out -----------------------------------------------------

  # Runs houston with output streamed live to the terminal (like the bash did).
  # Aborts the whole script on a non-zero exit.
  defp houston!(args) do
    {_stream, status} =
      System.cmd("houston", args, into: IO.stream(:stdio, :line), stderr_to_stdout: true)

    if status != 0 do
      die("houston exited with status #{status} (args: #{Enum.join(args, " ")})")
    end
  end

  # --- UI helpers ------------------------------------------------------------

  defp banner(provider_id, sale_count, s3_uri, dry_run?) do
    IO.puts("")
    IO.puts("============================================================")
    IO.puts("  process_missing_sales")
    IO.puts("  provider_id : #{provider_id}")
    IO.puts("  sale ids    : #{sale_count} sale(s)")
    IO.puts("  db          : houston psql #{@db_env} #{@db_name}")
    IO.puts("  s3          : #{s3_uri}")
    IO.puts("  task        : houston task run #{@service} #{@task}")
    IO.puts("  note        : sales with an existing document are skipped by the task")
    if dry_run?, do: IO.puts("  MODE        : DRY RUN (task will NOT be run)")
    IO.puts("============================================================")
    IO.puts("")
  end

  defp confirm!(prompt) do
    case prompt_value("#{prompt} (y to proceed, anything else aborts): ") do
      ans when ans in ["y", "Y"] -> :ok
      _ -> IO.puts("Aborted."); System.halt(1)
    end
  end

  defp prompt_value(label) do
    case IO.gets(label) do
      :eof -> ""
      {:error, _} -> ""
      line -> String.trim(line)
    end
  end

  defp die(msg) do
    IO.puts(:stderr, err("#{@cross} ERROR: #{msg}"))
    System.halt(1)
  end

  defp usage do
    __ENV__.file
    |> File.stream!()
    |> Enum.take_while(&(String.starts_with?(&1, "#") or String.trim(&1) == ""))
    |> Enum.reject(&String.starts_with?(&1, "#!"))
    |> Enum.map_join("", &Regex.replace(~r/^# ?/, &1, ""))
    |> String.trim()
    |> IO.puts()
  end

  defp indent(s), do: s |> String.trim_trailing() |> String.split("\n") |> Enum.map_join("\n", &("    " <> &1))

  defp hl(s), do: IO.ANSI.format([:bright, :white, s, :reset])
  defp ok(s), do: IO.ANSI.format([:bright, :green, s, :reset])
  defp warn(s), do: IO.ANSI.format([:bright, :yellow, s, :reset])
  defp err(s), do: IO.ANSI.format([:bright, :red, s, :reset])
end

ProcessMissingSales.run(System.argv())
