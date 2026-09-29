#!/usr/bin/env elixir

# backfill_missing_documents — backfill accounting documents for sales that never
# produced an invoice / credit note. PRODUCTION only: the production shedul
# database, the production S3 bucket and the production task.
#
# Pipeline:
#   1. Export the given sales to a CSV via `houston psql production shedul` (\copy),
#      filtered by provider_id + an explicit list of sale ids. A read.
#   2. Upload the CSV to
#      s3://fresha-accounting-documents-production/process_missing_sales_events_backfill/
#      via `houston aws-shell <profile> -- aws s3 cp`. A production write, and
#      made in a dry run too.
#   3. Run the `process_missing_sales_events` houston task against
#      `accounting-documents-web`, passing PROVIDER_ID + S3_KEY. Only with
#      --dry-run false.
#
# Each write (the upload, the task) is confirmed by typing "yes", then again by
# typing "production"; either answer wrong and the run stops before that write.
#
# The CSV column order is dictated by the task's parser
# (ProcessMissingSalesEventsTask.parse_row/1) — do NOT reorder the SELECT.
#
# The task always runs with FORCE unset: any sale that already has a document is
# skipped by the task (InvoiceProcessingRouter).
#
# Usage:
#   ./backfill_missing_documents.exs [provider_id] [sale_id1,sale_id2,...] [flags]
#
# On a terminal it asks for what is left out: whether to dry run (a picker:
# ↑↓ or j/k, enter picks, esc stops), then the provider_id and the sale ids
# (typed). Without a terminal it asks nothing: both must be given, the run is a
# dry run, and it stops before the upload, because a production write is
# confirmed by hand.
#
# Flags:
#   --dry-run BOOL     true (the default; a bare --dry-run means true): export,
#                      upload the CSV, print the exact task command, do NOT run
#                      the task. false: export, upload, then run the task.
#   --profile <name>   AWS profile for the S3 upload (default: fresha-production-team-orion).
#   --keep-csv         Keep the generated CSV on disk (prints the path).
#   --skip-upload      Only generate the CSV (implies --dry-run true, --keep-csv).
#   -h, --help         Show this help.
#
# Exit codes: 0 done, 1 a step failed or the operator stopped it, 2 the call was wrong.

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
    Process.put(:terminal, terminal_device())
    opts = ask_missing(opts)

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
    # Register the workdir so `halt/1` can remove it on EVERY exit path —
    # System.halt/1 bypasses the `after` block below (that only fires on normal
    # return or a raised exception), and this dir holds production sale data.
    Process.put(:pms_cleanup, {workdir, opts.keep_csv?})
    csv_path = Path.join(workdir, filename)
    sql_path = Path.join(workdir, "export.sql")

    try do
      write_copy_sql(sql_path, csv_path, provider_id, in_list)

      banner(provider_id, length(sale_ids), s3_uri, opts)

      # --- step 1: export CSV -------------------------------------------------
      IO.puts(hl("### Step 1 — export sales to CSV (read-only) ###"))
      IO.puts("Will run: houston psql #{@db_env} #{@db_name} -- -f <sql>")
      IO.puts("SQL to run:")
      File.read!(sql_path) |> indent() |> IO.puts()
      IO.puts("")
      # A read: asked on a terminal as it always was, run without asking otherwise.
      if terminal(), do: confirm!("Run the export now?")

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
        halt(0)
      end

      # --- step 2: upload to S3 (a production write) -------------------------
      IO.puts(hl("### Step 2 — upload CSV to S3 (production write) ###"))
      IO.puts("Will run: houston aws-shell #{opts.profile} -- aws s3 cp <csv> #{s3_uri}")

      unless terminal() do
        IO.puts(warn("[DRY RUN] No terminal: the upload writes to the production bucket and is confirmed by hand, so the run stops here."))
        IO.puts("Would upload to: #{s3_uri}")
        halt(0)
      end

      confirm_write!("upload the CSV to #{s3_uri}", "Aborted. Nothing was uploaded.")

      houston!(["aws-shell", opts.profile, "--", "aws", "s3", "cp", csv_path, s3_uri])
      IO.puts("Uploaded: #{s3_uri}")
      IO.puts("")

      # --- step 3: run the task (a production write) -------------------------
      task_args = [
        "task", "run", @service, @task,
        "-p", "PROVIDER_ID=#{provider_id}",
        "-p", "S3_KEY=#{s3_key}",
        "-w"
      ]

      IO.puts(hl("### Step 3 — run the backfill task (production write) ###"))
      IO.puts("Exact command:")
      IO.puts(indent("houston " <> Enum.join(task_args, " ")))
      IO.puts("")

      if opts.dry_run? do
        IO.puts(warn("[DRY RUN] Not running the task. Re-run with --dry-run false to execute."))
        IO.puts("CSV S3_KEY: #{s3_key}")
        halt(0)
      end

      confirm_write!(
        "run this PRODUCTION task",
        "Aborted. CSV already uploaded at #{s3_uri} (S3_KEY: #{s3_key})."
      )

      houston!(task_args)
      IO.puts("")
      IO.puts(ok("#{@check} backfill_missing_documents complete (provider #{provider_id}, #{length(sale_ids)} sale(s))."))
    after
      unless opts.keep_csv?, do: File.rm_rf(workdir)
    end
  end

  # --- arg parsing -----------------------------------------------------------

  defp parse_args(argv) do
    init = %{
      profile: @default_profile,
      keep_csv?: false,
      # nil = not given: asked on a terminal, true without one.
      dry_run?: nil,
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

  # A bare --dry-run means true; a value after it says which.
  defp do_parse(["--dry-run", v | rest], acc) when v in ["true", "false"],
    do: do_parse(rest, %{acc | dry_run?: v == "true"})

  defp do_parse(["--dry-run" | rest], acc), do: do_parse(rest, %{acc | dry_run?: true})
  defp do_parse(["--dry-run=" <> v | rest], acc), do: do_parse(rest, %{acc | dry_run?: bool_of(v)})

  defp do_parse(["--skip-upload" | rest], acc),
    do: do_parse(rest, %{acc | skip_upload?: true, keep_csv?: true})

  defp do_parse(["--profile"], _acc), do: usage_error("--profile needs a value")
  defp do_parse(["-" <> _ = flag | _rest], _acc), do: usage_error("unknown flag: #{flag}")
  defp do_parse([pos | rest], acc), do: do_parse(rest, %{acc | positional: [pos | acc.positional]})

  defp bool_of("true"), do: true
  defp bool_of("false"), do: false
  defp bool_of(v), do: usage_error("--dry-run takes true or false, got #{inspect(v)}")

  # --- asking the operator ---------------------------------------------------

  # Asks for whatever the flags left out. Without a terminal nothing is asked:
  # provider_id and the sale ids must be given, and the run is a dry run.
  defp ask_missing(opts) do
    if opts.skip_upload? and opts.dry_run? == false,
      do: usage_error("--skip-upload only builds the CSV; it cannot go with --dry-run false")

    cond do
      terminal() == nil ->
        if opts.provider_id == nil,
          do: usage_error("no provider_id given, and no terminal to ask on — pass <provider_id> <sale_ids>")

        if opts.sale_ids_raw == nil,
          do: usage_error("no sale ids given, and no terminal to ask on — pass <provider_id> <sale_ids>")

        if opts.dry_run? == false,
          do: usage_error("--dry-run false needs a terminal: every write is confirmed by hand")

        %{opts | dry_run?: true}

      opts.skip_upload? ->
        %{opts | dry_run?: true}

      opts.dry_run? == nil ->
        dry_run? =
          choose("Dry run?", [
            {true, "true", "export and upload the CSV, print the task command; run no task"},
            {false, "false", "export, upload, then run the production task — each write confirmed twice"}
          ])

        %{opts | dry_run?: dry_run?}

      true ->
        opts
    end
  end

  # A terminal is stdin and stdout both on the controlling terminal. Returns that
  # device's path, which the picker hands to stty, or nil. (The stty runs in a
  # child that has no controlling terminal — erl_child_setup calls setsid — so it
  # names the device instead of /dev/tty.)
  defp terminal_device do
    with true <- Keyword.get(:io.getopts(:standard_io), :terminal) == true,
         {out, 0} <- System.cmd("ps", ["-o", "tty=", "-p", System.pid()], stderr_to_stdout: true),
         name when name not in ["", "?", "??"] <- String.trim(out),
         dev = "/dev/" <> name,
         {:ok, %File.Stat{type: :device, minor_device: rdev}} <- File.stat("/dev/fd/0"),
         {:ok, %File.Stat{type: :device, minor_device: ^rdev}} <- File.stat(dev) do
      dev
    else
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp terminal, do: Process.get(:terminal)

  defp stty(dev, args), do: System.cmd("sh", ["-c", "stty #{args} < #{dev}"], stderr_to_stdout: true)

  # Pick one of a few with the arrow keys (or j/k, or the option's number); enter
  # takes the highlighted one, esc or Ctrl+C stops. The first option is
  # highlighted to begin with. Each keystroke repaints the options in place — the
  # cursor goes back up and every line clears only its own tail, one write per
  # frame — so the list never blanks between frames. The terminal's settings
  # (saved with stty -g, restored exactly) and its cursor come back however the
  # choice ends. Options are {value, label, note}.
  defp choose(question, options) do
    dev = terminal()
    IO.puts("  #{hl(question)}  #{faint("↑↓ move · enter picks · esc stops")}")
    {saved, 0} = stty(dev, "-g")

    result =
      try do
        stty(dev, "raw -echo")
        IO.write("\e[?25l")
        draw(options, 0, true)
        pick(options, 0)
      after
        stty(dev, "'#{String.trim(saved)}'")
        IO.write("\e[?25h")
      end

    case result do
      {:ok, value} ->
        value

      :stop ->
        IO.puts(err("✗ stopped at a prompt — nothing was run."))
        halt(1)
    end
  end

  defp pick(options, at) do
    n = length(options)

    case read_key() do
      k when k in ["\e[A", "\eOA", "k"] -> move(options, at, rem(at - 1 + n, n))
      k when k in ["\e[B", "\eOB", "j"] -> move(options, at, rem(at + 1, n))
      <<d>> when d in ?1..?9 and d - ?0 <= n -> move(options, at, d - ?1)
      k when k in ["\r", "\n"] -> {:ok, options |> Enum.at(at) |> elem(0)}
      k when k in ["\e", <<3>>, <<4>>, "q"] -> :stop
      _ -> pick(options, at)
    end
  end

  # A key that changes nothing on screen writes nothing.
  defp move(options, at, at), do: pick(options, at)
  defp move(options, _before, at), do: (draw(options, at, false); pick(options, at))

  # Raw mode turns off the terminal's own newline translation, hence \r\n.
  defp draw(options, at, first?) do
    frame =
      options
      |> Enum.with_index()
      |> Enum.map_join(fn {{_value, label, note}, i} ->
        line = if i == at, do: "  #{cmd("❯")} #{hl(label)}", else: "    #{label}"
        note = if note, do: faint("  · #{note}"), else: ""
        line <> note <> "\e[K\r\n"
      end)

    IO.write(if(first?, do: "", else: "\e[#{length(options)}A\r") <> frame)
  end

  # One key: an escape sequence, a lone esc, or one byte. A lone esc is told
  # from the start of a sequence by nothing following it within 80 ms; esc stops
  # the run, so the read left waiting then never matters.
  defp read_key do
    case IO.binread(:stdio, 1) do
      "\e" ->
        next = Task.async(fn -> IO.binread(:stdio, 1) end)

        case Task.yield(next, 80) do
          {:ok, b} when b in ["[", "O"] -> "\e" <> b <> read_sequence("")
          _ -> "\e"
        end

      b when is_binary(b) ->
        b

      _eof ->
        <<4>>
    end
  end

  defp read_sequence(acc) do
    case IO.binread(:stdio, 1) do
      <<c>> = b when c in ?0..?9 or c == ?; -> read_sequence(acc <> b)
      b when is_binary(b) -> acc <> b
      _ -> acc
    end
  end

  # A write: confirmed by typing "yes", and — this is production — a second time
  # by typing "production". Either answer wrong and the run stops before it.
  defp confirm_write!(what, aborted) do
    yes = prompt_value(~s(Type "yes" to #{what}: )) |> String.downcase()
    unless yes == "yes", do: (IO.puts(aborted); halt(1))

    again = prompt_value(~s(This writes #{err("PRODUCTION")}. Type "production" to confirm: ))
    unless again == "production", do: (IO.puts(aborted); halt(1))
  end

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

  defp banner(provider_id, sale_count, s3_uri, opts) do
    mode =
      cond do
        opts.skip_upload? -> "CSV ONLY (--skip-upload): export, keep the CSV, upload nothing"
        opts.dry_run? -> "DRY RUN — export + upload, the task will NOT be run"
        true -> "LIVE — export, upload, then run the task"
      end

    IO.puts("")
    IO.puts("============================================================")
    IO.puts("  backfill_missing_documents — #{err("PRODUCTION")}")
    IO.puts("  provider_id : #{provider_id}")
    IO.puts("  sale ids    : #{sale_count} sale(s)")
    IO.puts("  db          : houston psql #{@db_env} #{@db_name}")
    IO.puts("  s3          : #{s3_uri}")
    IO.puts("  task        : houston task run #{@service} #{@task}")
    IO.puts("  note        : sales with an existing document are skipped by the task")
    IO.puts("  MODE        : #{mode}")
    unless opts.skip_upload?, do: IO.puts("  writes      : each confirmed twice — \"yes\", then \"production\"")
    IO.puts("============================================================")
    IO.puts("")
  end

  defp confirm!(prompt) do
    case prompt_value("#{prompt} (y to proceed, anything else aborts): ") do
      ans when ans in ["y", "Y"] -> :ok
      _ -> IO.puts("Aborted."); halt(1)
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
    halt(1)
  end

  # The call was wrong: exit 2.
  defp usage_error(msg) do
    IO.puts(:stderr, err("#{@cross} ERROR: #{msg}"))
    halt(2)
  end

  # Cleanup-safe halt: removes the registered workdir (unless --keep-csv) before
  # halting, because System.halt/1 skips the `after` block in run/1. Safe to call
  # before the workdir is registered (no-op if nothing to clean).
  defp halt(code) do
    case Process.get(:pms_cleanup) do
      {workdir, false} -> File.rm_rf(workdir)
      _ -> :ok
    end

    System.halt(code)
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

  defp hl(s), do: IO.ANSI.format([:bright, :white, s, :reset]) |> IO.chardata_to_string()
  defp ok(s), do: IO.ANSI.format([:bright, :green, s, :reset]) |> IO.chardata_to_string()
  defp warn(s), do: IO.ANSI.format([:bright, :yellow, s, :reset]) |> IO.chardata_to_string()
  defp err(s), do: IO.ANSI.format([:bright, :red, s, :reset]) |> IO.chardata_to_string()
  defp faint(s), do: IO.ANSI.format([:faint, s, :reset]) |> IO.chardata_to_string()
  defp cmd(s), do: IO.ANSI.format([:yellow, s, :reset]) |> IO.chardata_to_string()
end

ProcessMissingSales.run(System.argv())
