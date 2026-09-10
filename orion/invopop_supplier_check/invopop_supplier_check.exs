#!/usr/bin/env elixir

Mix.install([{:req, "~> 0.5"}, {:nimble_csv, "~> 1.2"}])

defmodule Dotenv do
  @moduledoc false
  # Load KEY=VALUE pairs from the repo-root `.env` into the environment, without
  # overriding anything already set (real env wins). Repo root = nearest ancestor
  # dir containing `.env.example`. Silent no-op if there's no `.env`.

  def load do
    with root when is_binary(root) <- find_root(Path.dirname(__ENV__.file)),
         path = Path.join(root, ".env"),
         true <- File.exists?(path) do
      path |> File.stream!() |> Enum.each(&put_line/1)
    else
      _ -> :ok
    end
  end

  defp put_line(line) do
    line = String.trim(line)

    with false <- line == "" or String.starts_with?(line, "#"),
         [k, v] <- String.split(line, "=", parts: 2) do
      key = String.trim(k)
      val = v |> String.trim() |> String.trim("\"") |> String.trim("'")
      if System.get_env(key) in [nil, ""], do: System.put_env(key, val)
    else
      _ -> :ok
    end
  end

  defp find_root(dir) do
    cond do
      File.exists?(Path.join(dir, ".env.example")) -> dir
      Path.dirname(dir) == dir -> nil
      true -> find_root(Path.dirname(dir))
    end
  end
end

defmodule InvopopSupplierCheck do
  @moduledoc false
  # -- Purpose: list Invopop "suppliers" silo entries and diagnose ones in problem states.
  # -- Transport: Invopop REST API (https://api.invopop.com) via Req. No houston needed
  # --            (optional provider cross-reference uses `houston psql accounting-documents`).
  # -- Auth: Bearer token from INVOPOP_API_TOKEN, else paste prompt. The token itself
  # --       determines which integration/workspace (ES, IT, …) we're querying.
  # -- Base URL override: INVOPOP_API_BASE_URL

  @check "✅"
  @cross "❌"
  @wait "⏳"
  @void "⊘"

  @default_base_url "https://api.invopop.com"
  @suppliers_folder "suppliers"
  @page_limit 100

  # State classification. `state` is a free string in Invopop; these sets are derived from
  # what we see in practice and are easy to tweak. Anything not clearly "ok" is treated as a
  # problem so nothing stuck is hidden.
  # Invopop silo states: draft, processing, registered, completed, sent, received,
  # paid, error, rejected, void, invalid. For suppliers the ones that matter are
  # registered (ok), error (problem), void (cancelled).
  @ok_states ~w(registered completed sent received paid accepted done)
  @pending_states ~w(draft processing pending queued waiting)
  @error_states ~w(error rejected invalid)
  @voided_states ~w(void voided cancelled canceled)

  @token_env "INVOPOP_API_TOKEN"

  def run(argv) do
    Dotenv.load()

    flag_problems? = "--problems" in argv
    flag_report? = "--report" in argv
    debug? = "--debug" in argv

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Invopop supplier check ===", :reset]))

    base_url = System.get_env("INVOPOP_API_BASE_URL") || @default_base_url
    token = resolve_token()

    if not filled?(token) do
      IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} No API token provided. Aborting.", :reset]))
      System.halt(1)
    end

    client = build_client(base_url, token)
    IO.puts(IO.ANSI.format([:faint, "Base URL: #{base_url}", :reset]))

    workspace = show_workspace(client)

    created_after = prompt_date_range()
    problems_only? = flag_problems? or prompt_problems_filter()
    query_db? = prompt_db_lookup()
    write_report? = flag_report? or prompt_report()

    base_params =
      [folder: @suppliers_folder, limit: @page_limit]
      |> maybe_put(:created_at, created_after)
      |> maybe_put(:ascending, created_after && true)

    IO.puts(IO.ANSI.format([:faint, "Fetching '#{@suppliers_folder}' entries...", :reset]))

    entries =
      fetch_all_suppliers(client, base_params, nil, [], MapSet.new(), debug?)
      |> date_filter(created_after)

    classified = Enum.map(entries, fn e -> {classify(e), e} end)

    summarize(classified)

    db = if query_db?, do: build_db_context(classified), else: nil

    grouped_report(classified, problems_only?, db)

    if write_report?,
      do: write_markdown_report(classified, problems_only?, db, created_after, workspace)
  end

  defp print_legend(query_db?) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Known scenarios ===", :reset]))

    IO.puts("  Entry states:")
    IO.puts(IO.ANSI.format([:green, "    #{@check} ok", :reset, "       registered / completed / sent / received / paid"]))
    IO.puts(IO.ANSI.format([:yellow, "    #{@wait} pending", :reset, "  draft / processing"]))
    IO.puts(IO.ANSI.format([:red, "    #{@cross} error", :reset, "    error / rejected / invalid — faults listed under the entry (↳)"]))
    IO.puts(IO.ANSI.format([:light_black, "    #{@void} voided", :reset, "   void"]))

    IO.puts("  Supplier flags (⚠️):")
    IO.puts("    error                  an error entry NOT followed by a later success")
    IO.puts("    faults                 an entry with faults NOT followed by a later success")
    IO.puts("    N processing (race)    more than one processing entry at once")
    IO.puts("    stale pending (→ok)    an older pending entry followed by a successful one")

    if query_db? do
      IO.puts("  DB (per supplier / per entry):")
      IO.puts("    DB   …                 default plugin row for the supplier (plugin/third_party status, ids)")
      IO.puts(IO.ANSI.format([:red, "    DB #{@cross} …", :reset, "                 no default plugin row found"]))
      IO.puts("    req  type/status ×N     register/deregister requests for the supplier's account config")
      IO.puts("    req=type/status        a request matching that silo entry by external_correlation_id")
    end
  end

  defp prompt_date_range do
    IO.puts("Date range (rolling window from now):")
    IO.puts("  1) Last 1 day")
    IO.puts("  2) Last 7 days  (default)")
    IO.puts("  3) Last 1 month")
    IO.puts("  4) Last 3 months")
    IO.puts("  5) All time")

    now = DateTime.utc_now()
    days_ago = fn n -> now |> DateTime.add(-n * 24 * 3600, :second) |> DateTime.to_iso8601() end

    # blank / unrecognized → default to last 7 days
    iso =
      case prompt_value("choice (1-5) [default 2]: ") do
        "1" -> days_ago.(1)
        "3" -> days_ago.(30)
        "4" -> days_ago.(90)
        "5" -> nil
        _ -> days_ago.(7)
      end

    if iso,
      do: IO.puts(IO.ANSI.format([:faint, "Filtering to created_at >= #{iso} (UTC)", :reset])),
      else: IO.puts(IO.ANSI.format([:faint, "No date filter (all time).", :reset]))

    iso
  end

  defp prompt_db_lookup do
    IO.puts(
      IO.ANSI.format([
        :yellow,
        "\n⚠️  The DB cross-reference queries account_configurations / " <>
          "account_configuration_plugins keyed on account_configuration_id — the " <>
          "pre-Billing-Profiles schema. It will return nothing / drift once the " <>
          "Billing Profiles migration lands. The Invopop API check above is unaffected.",
        :reset
      ])
    )

    ans = prompt_value("Also look up plugin statuses in the DB (houston psql)? (y/N): ") |> String.downcase()
    ans in ["y", "yes"]
  end

  defp prompt_report do
    ans = prompt_value("Write a Markdown report file? (y/N): ") |> String.downcase()
    ans in ["y", "yes"]
  end

  defp prompt_problems_filter do
    ans = prompt_value("Show only problematic suppliers? (y/N): ") |> String.downcase()
    ans in ["y", "yes"]
  end

  defp date_filter(entries, nil), do: entries

  defp date_filter(entries, created_after) do
    Enum.filter(entries, fn e -> to_string(e["created_at"]) >= created_after end)
  end

  # --- Auth ---

  defp resolve_token do
    case System.get_env(@token_env) do
      v when is_binary(v) and v != "" ->
        IO.puts(IO.ANSI.format([:faint, "Using token from $#{@token_env}.", :reset]))
        v

      _ ->
        IO.puts(IO.ANSI.format([:faint, "$#{@token_env} not set.", :reset]))
        prompt_value("Paste Invopop API token: ")
    end
  end

  # --- Workspace ---

  defp show_workspace(client) do
    case Req.get(client, url: "/access/v1/workspace") do
      {:ok, %{status: s, body: w}} when s in 200..299 and is_map(w) ->
        env =
          if truthy?(w["sandbox"]),
            do: IO.ANSI.format([:bright, :yellow, "SANDBOX", :reset]),
            else: IO.ANSI.format([:bright, :green, "PRODUCTION", :reset])

        IO.puts("")
        IO.puts(IO.ANSI.format([:bright, :white, "=== Workspace ===", :reset]))
        IO.puts("  name:    #{w["name"]}  (#{env})")
        IO.puts("  slug:    #{w["slug"]}")
        IO.puts("  country: #{w["country"]}")
        IO.puts("  id:      #{w["id"]}")
        IO.puts(IO.ANSI.format([:faint, "  created: #{w["created_at"]}", :reset]))

        %{slug: w["slug"], name: w["name"], country: w["country"]}

      {:ok, %{status: s, body: body}} ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  Could not fetch workspace (HTTP #{s}): #{inspect(body)}", :reset]))
        nil

      {:error, reason} ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  Could not fetch workspace: #{inspect(reason)}", :reset]))
        nil
    end
  end

  # --- HTTP ---

  defp build_client(base_url, token) do
    Req.new(
      base_url: base_url,
      auth: {:bearer, token},
      connect_options: [timeout: 10_000],
      receive_timeout: 15_000
    )
  end

  defp fetch_all_suppliers(client, base_params, cursor, acc, seen_ids, debug?) do
    params = if cursor, do: Keyword.put(base_params, :cursor, cursor), else: base_params

    case Req.get(client, url: "/silo/v1/entries", params: params) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        if debug? and acc == [] do
          IO.puts(IO.ANSI.format([:faint, "--- raw first response ---", :reset]))
          IO.puts(inspect(body, pretty: true, limit: :infinity, printable_limit: :infinity))
          IO.puts(IO.ANSI.format([:faint, "--- end raw response (top-level keys: #{inspect(Map.keys(body))}) ---", :reset]))
        end

        entries = extract_entries(body)
        # Stop on entries we've already collected — the API keeps returning a cursor
        # even past the last page, so dedup-by-id is what actually terminates the loop.
        new_entries = Enum.reject(entries, fn e -> MapSet.member?(seen_ids, e["id"]) end)
        seen_ids = Enum.reduce(new_entries, seen_ids, fn e, acc -> MapSet.put(acc, e["id"]) end)
        acc = acc ++ new_entries
        next = is_map(body) && (body["next_cursor"] || body["cursor"])

        IO.puts(IO.ANSI.format([:faint, "  fetched #{length(new_entries)} new (total #{length(acc)})", :reset]))

        cond do
          new_entries == [] ->
            acc

          not filled?(next) or next == cursor ->
            acc

          true ->
            IO.puts(IO.ANSI.format([:faint, "  …next page in 5s", :reset]))
            Process.sleep(5_000)
            fetch_all_suppliers(client, base_params, next, acc, seen_ids, debug?)
        end

      {:ok, %{status: status, body: body}} ->
        IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} Invopop API returned HTTP #{status}", :reset]))
        IO.puts(IO.ANSI.format([:red, inspect(body), :reset]))
        if status in [401, 403], do: IO.puts(IO.ANSI.format([:yellow, "→ Token rejected. Check the API key / integration.", :reset]))
        System.halt(1)

      {:error, reason} ->
        IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} Request failed: #{inspect(reason)}", :reset]))
        System.halt(1)
    end
  end

  # Invopop list responses have varied across versions; accept whichever array shows up.
  defp extract_entries(body) when is_list(body), do: body

  defp extract_entries(body) when is_map(body) do
    cond do
      is_list(body["entries"]) -> body["entries"]
      is_list(body["list"]) -> body["list"]
      is_list(body["data"]) -> body["data"]
      is_list(body["results"]) -> body["results"]
      true -> []
    end
  end

  defp extract_entries(_), do: []

  # --- Classification ---

  defp classify(entry) do
    faults = entry["faults"] || []
    state = entry["state"] |> to_string() |> String.downcase()

    cond do
      state in @voided_states -> :voided
      state in @error_states -> :error
      faults != [] -> :error
      truthy?(entry["invalid"]) -> :error
      state in @ok_states -> :ok
      state in @pending_states -> :pending
      truthy?(entry["draft"]) -> :pending
      state == "" -> :pending
      true -> :unknown
    end
  end

  # --- Output ---

  defp summarize(classified) do
    counts = Enum.frequencies_by(classified, fn {c, _} -> c end)
    total = length(classified)

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Summary ===", :reset]))
    IO.puts("  total:   #{total}")
    IO.puts(IO.ANSI.format([:green, "  ok:      #{Map.get(counts, :ok, 0)}", :reset]))
    IO.puts(IO.ANSI.format([:yellow, "  pending: #{Map.get(counts, :pending, 0)}", :reset]))
    IO.puts(IO.ANSI.format([:red, "  error:   #{Map.get(counts, :error, 0)}", :reset]))
    IO.puts(IO.ANSI.format([:light_black, "  voided:  #{Map.get(counts, :voided, 0)}", :reset]))
    IO.puts(IO.ANSI.format([:faint, "  unknown: #{Map.get(counts, :unknown, 0)}", :reset]))
  end

  # Full report: group requests by supplier, requests newest-first within a supplier,
  # supplier groups sorted by their most recent request (newest first).
  # With problems_only?, keep only problematic suppliers (see problematic_supplier?/1).
  # Build the ordered list of {sorted_items, sort_key} supplier groups (shared by the
  # console report and the markdown export).
  defp build_groups(classified, problems_only?) do
    classified
    |> Enum.group_by(fn {_c, e} -> supplier_key(e) end)
    |> Enum.map(fn {_key, items} ->
      # newest request first within each supplier
      sorted = Enum.sort_by(items, fn {_c, e} -> to_string(e["created_at"]) end, :desc)
      {latest_class, latest_e} = hd(sorted)
      # priority 1 = the supplier's most recent entry is an error → float to the top
      err_priority = if latest_class == :error, do: 1, else: 0
      {sorted, {err_priority, to_string(latest_e["created_at"])}}
    end)
    # error-latest suppliers first, then by most recent request (both descending)
    |> Enum.sort_by(fn {_sorted, sort_key} -> sort_key end, :desc)
    |> then(fn all ->
      if problems_only?,
        do: Enum.filter(all, fn {items, _} -> problematic_supplier?(items) end),
        else: all
    end)
  end

  defp grouped_report(classified, problems_only?, db) do
    groups = build_groups(classified, problems_only?)
    request_count = groups |> Enum.map(fn {items, _} -> length(items) end) |> Enum.sum()

    print_legend(db != nil)

    IO.puts("")
    title = if problems_only?, do: "Report — problematic suppliers", else: "Report — all suppliers"
    IO.puts(IO.ANSI.format([:bright, :white, "=== #{title} (#{length(groups)} suppliers, #{request_count} entries) ===", :reset]))

    if groups == [] do
      IO.puts(IO.ANSI.format([:green, "  #{@check} nothing to report", :reset]))
    else
      Enum.each(groups, fn {items, _sort_key} ->
        {_c, first} = hd(items)
        tax = supplier_fields(first).tax

        print_supplier_header(first, length(items), problem_reasons(items))
        print_db_inline(tax, db)
        print_entries(items, db)
      end)

      unless problems_only?, do: IO.puts(IO.ANSI.format([:faint, "\n(pass --problems to show only problematic suppliers)", :reset]))
    end
  end

  defp print_supplier_header(first, count, reasons) do
    entries = if count == 1, do: "entry", else: "entries"
    header = [:bright, :cyan, "▸ #{supplier_label(first)}   (#{count} #{entries})", :reset]
    flag = if reasons == "", do: [], else: [:bright, :red, "   ⚠️  #{reasons}", :reset]

    IO.puts("")
    IO.puts(IO.ANSI.format(header ++ flag))
  end

  # Non-void entries listed individually (newest first); voids collapsed to one summary line.
  defp print_entries(items, db) do
    {voids, rest} = Enum.split_with(items, fn {c, _} -> c == :voided end)
    Enum.each(rest, fn {class, e} -> print_entry(class, e, db) end)
    print_void_summary(voids)
  end

  defp print_void_summary([]), do: :ok

  defp print_void_summary(voids) do
    dates = voids |> Enum.map(fn {_c, e} -> to_string(e["created_at"]) end) |> Enum.sort()
    range = if hd(dates) == List.last(dates), do: short_ts(hd(dates)), else: "#{short_ts(hd(dates))} → #{short_ts(List.last(dates))}"
    IO.puts(IO.ANSI.format([:light_black, "    #{@void} #{length(voids)} void   #{range}", :reset]))
  end

  # --- Markdown report export ---

  defp write_markdown_report(classified, problems_only?, db, created_after, workspace) do
    groups = build_groups(classified, problems_only?)
    counts = Enum.frequencies_by(classified, fn {c, _} -> c end)
    now = DateTime.utc_now()
    stamp = now |> DateTime.to_iso8601() |> String.replace(~r/[:.]/, "-")
    regime = detect_regime(classified)
    dir = Path.join(System.tmp_dir!(), "invopop_reports")
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{report_basename(workspace, regime)}_#{stamp}.md")

    request_count = groups |> Enum.map(fn {items, _} -> length(items) end) |> Enum.sum()

    head = [
      "# Invopop supplier report\n\n",
      "- Workspace: #{workspace_label(workspace)}\n",
      "- Country: #{(workspace && workspace[:country]) || "(unknown)"}\n",
      "- Regime: #{if regime == "", do: "(undetermined)", else: regime}\n",
      "- Generated: #{DateTime.to_iso8601(now)} (UTC)\n",
      "- Date range: #{if created_after, do: "created_at >= #{created_after}", else: "all time"}\n",
      "- Filter: #{if problems_only?, do: "problematic suppliers only", else: "all suppliers"}\n",
      "- DB lookup: #{if db, do: "yes", else: "no"}\n",
      "- Suppliers: #{length(groups)} — Requests: #{request_count}\n",
      "- Totals: ok #{Map.get(counts, :ok, 0)}, pending #{Map.get(counts, :pending, 0)}, " <>
        "error #{Map.get(counts, :error, 0)}, voided #{Map.get(counts, :voided, 0)}, " <>
        "unknown #{Map.get(counts, :unknown, 0)} (#{length(classified)} entries)\n\n"
    ]

    body =
      if groups == [],
        do: ["_Nothing to report._\n"],
        else: Enum.map(groups, fn {items, _} -> md_supplier(items, db) end)

    case File.write(path, IO.iodata_to_binary([head, body])) do
      :ok ->
        IO.puts("")
        IO.puts(IO.ANSI.format([:bright, :green, "#{@check} Report written: #{path}", :reset]))

      {:error, reason} ->
        IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} Could not write report: #{inspect(reason)}", :reset]))
    end
  end

  # "Name (slug)" when a name is present, else the slug, else "(unknown)".
  defp workspace_label(nil), do: "(unknown)"

  defp workspace_label(ws) do
    cond do
      filled?(ws[:name]) and filled?(ws[:slug]) -> "#{ws[:name]} (#{ws[:slug]})"
      filled?(ws[:slug]) -> ws[:slug]
      filled?(ws[:name]) -> ws[:name]
      true -> "(unknown)"
    end
  end

  # Filename base from the workspace + detected regime: "<slug>_<country>_<regime>"
  # (e.g. "fresha_production_es_verifactu"), so each workspace's report is saved
  # separately. Tokens already present in the slug are skipped so a descriptive slug
  # like "invopop_es_verifactu_etec" isn't duplicated.
  defp report_basename(nil, _regime), do: "invopop_report"

  defp report_basename(ws, regime) do
    slug = sanitize_token(ws[:slug])

    extras =
      [sanitize_token(ws[:country]), sanitize_token(regime)]
      |> Enum.reject(fn t -> t == "" or (slug != "" and String.contains?(slug, t)) end)

    case Enum.reject([slug | extras], &(&1 == "")) do
      [] -> "invopop_report"
      parts -> Enum.join(parts, "_")
    end
  end

  # Detect the e-invoicing regime from the entries themselves (ES can be VeriFactu OR
  # TicketBAI, so we don't assume from country). Signals: fault provider/codes
  # (e.g. "verifactu.wait.upload", "tbai.*") and GOBL $addons ("es-verifactu-v1",
  # "es-tbai-v1"). Returns "" when there's no signal or both appear (don't guess).
  defp detect_regime(classified) do
    signals = classified |> Enum.flat_map(fn {_c, e} -> regime_signals(e) end) |> Enum.uniq()

    cond do
      "verifactu" in signals and "tbai" not in signals -> "verifactu"
      "tbai" in signals and "verifactu" not in signals -> "tbai"
      true -> ""
    end
  end

  defp regime_signals(e) do
    fault_text =
      (e["faults"] || [])
      |> Enum.flat_map(fn f -> [to_string(f["provider"]), to_string(f["code"])] end)

    data = unwrap_doc(e["data"] || %{})

    addon_text =
      case data["$addons"] || data["addons"] do
        list when is_list(list) -> Enum.map(list, &to_string/1)
        _ -> []
      end

    (fault_text ++ addon_text)
    |> Enum.flat_map(fn s ->
      s = String.downcase(s)

      [
        String.contains?(s, "verifactu") && "verifactu",
        (String.contains?(s, "tbai") or String.contains?(s, "ticketbai")) && "tbai"
      ]
    end)
    |> Enum.filter(& &1)
  end

  defp sanitize_token(v) do
    v |> to_string() |> String.downcase() |> String.replace(~r/[^a-z0-9]+/, "_") |> String.trim("_")
  end

  defp md_supplier(items, db) do
    {_c, first} = hd(items)
    tax = supplier_fields(first).tax
    reasons = problem_reasons(items)
    flag = if reasons == "", do: "", else: " — ⚠️ #{reasons}"

    rows =
      Enum.map(items, fn {class, e} ->
        msg =
          case e["faults"] || [] do
            [f | _] -> "#{f["provider"]}/#{f["code"]}: #{truncate(f["message"], 80)}"
            _ -> ""
          end

        "| #{class_mark(class)} #{e["state"]} | #{short_ts(e["created_at"])} | #{length(e["faults"] || [])} | #{md_escape(to_string(e["id"]))} | #{md_request(e, db)} | #{md_escape(msg)} |\n"
      end)

    [
      "## #{md_escape(supplier_label(first))}#{flag}\n\n",
      md_db(tax, db),
      "| state | created | faults | silo id | request | first fault |\n",
      "|---|---|---|---|---|---|\n",
      rows,
      "\n"
    ]
  end

  defp md_request(_e, nil), do: ""

  defp md_request(e, %{requests_by_entry: by_entry}) do
    case Map.get(by_entry, to_string(e["id"])) do
      nil -> "—"
      r -> "#{r["application_type"]}/#{r["status"]}"
    end
  end

  defp md_db(_tax, nil), do: ""

  defp md_db(tax, db) do
    plugin =
      cond do
        not filled?(tax) ->
          "_DB: no tax id to look up_\n"

        true ->
          case Map.get(db.plugins, tax) do
            rows when rows in [nil, []] ->
              "**DB: ❌ no default plugin row found**\n"

            rows ->
              Enum.map(rows, fn r ->
                "- DB: #{status_dot(Map.get(r, "plugin_status", ""))} " <>
                  "provider_id=#{Map.get(r, "provider_id", "?")} " <>
                  "acct_config_id=#{Map.get(r, "account_configuration_id", "?")} " <>
                  "plugin_id=#{Map.get(r, "plugin_id", "?")} " <>
                  "country=#{Map.get(r, "country_code", "")} " <>
                  "plugin=#{Map.get(r, "plugin_status", "")} " <>
                  "third_party=#{Map.get(r, "third_party_integration_status", "")}\n"
              end)
          end
      end

    requests =
      case acct_requests(tax, db) do
        [] ->
          ""

        reqs ->
          summary = "- req: #{request_breakdown_text(request_counts(reqs))}\n"

          # Each request with the date/time it was made, newest first.
          list =
            reqs
            |> Enum.sort_by(&Map.get(&1, "created_at", ""), :desc)
            |> Enum.map(fn r ->
              "  - #{status_dot(to_string(r["status"]))} #{r["application_type"]}/#{r["status"]} — #{short_ts(Map.get(r, "created_at"))}\n"
            end)

          [summary, list]
      end

    [plugin, requests, "\n"]
  end

  defp md_escape(s), do: s |> to_string() |> String.replace("|", "\\|")

  # A supplier is problematic if any of:
  #   - an error entry NOT followed by a later successful entry (a later success resolves it)
  #   - an entry with faults NOT followed by a later successful entry
  #   - more than one entry is still "processing" (likely race condition)
  #   - a pending entry is chronologically followed by an ok one (stale/orphaned pending)
  defp problematic_supplier?(items), do: problem_reasons(items) != ""

  defp problem_reasons(items) do
    processing = Enum.count(items, fn {_c, e} -> entry_state(e) == "processing" end)

    ok_times = for {:ok, e} <- items, do: to_string(e["created_at"])
    latest_ok = if ok_times == [], do: "", else: Enum.max(ok_times)

    # "followed by a success" = some ok entry created after this one (ISO ts compare lexicographically)
    unresolved_error? =
      Enum.any?(items, fn {c, e} -> c == :error and to_string(e["created_at"]) > latest_ok end)

    unresolved_faults? =
      Enum.any?(items, fn {_c, e} -> (e["faults"] || []) != [] and to_string(e["created_at"]) > latest_ok end)

    [
      unresolved_error? && "error",
      unresolved_faults? && "faults",
      processing > 1 && "#{processing} processing (race)",
      pending_then_ok?(items) && "stale pending (pending→ok)"
    ]
    |> Enum.filter(& &1)
    |> Enum.join(", ")
  end

  defp pending_then_ok?(items) do
    pendings = for {:pending, e} <- items, do: to_string(e["created_at"])
    oks = for {:ok, e} <- items, do: to_string(e["created_at"])
    # ISO-8601 timestamps compare lexicographically
    Enum.any?(pendings, fn p -> Enum.any?(oks, fn o -> p < o end) end)
  end

  defp entry_state(e), do: e["state"] |> to_string() |> String.downcase()

  defp supplier_key(e) do
    f = supplier_fields(e)

    cond do
      filled?(f.tax) -> "tax:" <> f.tax
      filled?(f.name) -> "name:" <> f.name
      true -> "key:" <> to_string(e["key"] || e["id"])
    end
  end

  defp supplier_label(e) do
    f = supplier_fields(e)
    name = if filled?(f.name), do: f.name, else: "(unknown supplier)"

    [
      name,
      filled?(f.tax) && "tax=#{f.country}#{f.tax}",
      filled?(f.crn) && "crn=#{f.crn}"
    ]
    |> Enum.filter(& &1)
    |> Enum.join("  ")
  end

  # tax_code is the supplier identity. Look for it (and name/crn/country) across the
  # places Invopop may expose it: top-level, snippet, or the GOBL party in data
  # (which may be wrapped in a "doc" envelope).
  defp supplier_fields(e) do
    data = unwrap_doc(e["data"] || %{})
    snip = unwrap_doc(e["snippet"] || %{})

    %{
      tax:
        first_filled([
          e["tax_code"],
          snip["tax_code"],
          data["tax_code"],
          get_in(data, ["tax_id", "code"]),
          get_in(snip, ["tax_id", "code"])
        ]),
      name: first_filled([e["name"], snip["name"], data["name"]]),
      country:
        first_filled([
          e["country"],
          get_in(data, ["tax_id", "country"]),
          get_in(snip, ["tax_id", "country"])
        ]),
      crn:
        first_filled([
          get_in(data, ["registration", "entry"]),
          e["company_registration_number"]
        ])
    }
  end

  defp unwrap_doc(%{"doc" => doc}) when is_map(doc), do: doc
  defp unwrap_doc(m) when is_map(m), do: m
  defp unwrap_doc(_), do: %{}

  defp first_filled(values), do: Enum.find(values, &filled?/1)

  # Status emoji for an entry classification — shared by the console and the markdown report.
  defp class_mark(:ok), do: @check
  defp class_mark(:pending), do: @wait
  defp class_mark(:error), do: @cross
  defp class_mark(:voided), do: @void
  defp class_mark(_), do: "❔"

  defp print_entry(class, e, db) do
    color =
      case class do
        :ok -> :green
        :pending -> :yellow
        :error -> :red
        :voided -> :light_black
        _ -> :faint
      end

    mark = class_mark(class)
    faults = e["faults"] || []
    state = String.pad_trailing(to_string(e["state"] || "?"), 11)
    fault_suffix = if faults == [], do: "", else: "   faults=#{length(faults)}"

    IO.puts(
      IO.ANSI.format([
        color,
        "    #{mark} #{state} #{short_id(e["id"])}   #{short_ts(e["created_at"])}#{fault_suffix}#{request_suffix(e, db)}",
        :reset
      ])
    )

    # error → list every fault under the entry
    Enum.each(faults, fn f ->
      IO.puts(IO.ANSI.format([:red, "        ↳ [#{f["provider"]}] #{f["code"]}: #{truncate(f["message"], 120)}", :reset]))
    end)
  end

  # The einvoice request whose external_correlation_id == this silo entry id, if any.
  defp request_suffix(_e, nil), do: ""

  defp request_suffix(e, %{requests_by_entry: by_entry}) do
    case Map.get(by_entry, to_string(e["id"])) do
      nil -> "   req=—"
      r -> "   req=#{r["application_type"]}/#{r["status"]}"
    end
  end

  # ISO-8601 → "YYYY-MM-DD HH:MM"
  defp short_ts(nil), do: ""

  defp short_ts(ts) do
    case ts |> to_string() |> String.split("T") do
      [d, t] -> d <> " " <> String.slice(t, 0, 5)
      _ -> to_string(ts)
    end
  end

  # --- DB context: default plugin per tax + the einvoice request per silo entry ---

  # Builds %{plugins: %{tax=>[rows]}, requests_by_entry: %{external_correlation_id=>row},
  #          requests_by_acct: %{account_configuration_id=>[rows]}}.
  # Requests are joined to suppliers by account_configuration_id (the reliable FK we get
  # from the plugin lookup), then matched per silo entry by external_correlation_id.
  defp build_db_context(classified) do
    tax_codes =
      classified
      |> Enum.map(fn {_c, e} -> supplier_fields(e).tax end)
      |> Enum.filter(&filled?/1)
      |> Enum.uniq()

    plugins = fetch_plugins(tax_codes)

    acct_ids =
      plugins
      |> Map.values()
      |> List.flatten()
      |> Enum.map(&Map.get(&1, "account_configuration_id"))
      |> Enum.filter(&filled?/1)
      |> Enum.uniq()

    requests = fetch_requests_by_acct(acct_ids)

    %{
      plugins: plugins,
      requests_by_entry: Map.new(requests, fn r -> {Map.get(r, "external_correlation_id", ""), r} end),
      requests_by_acct: Enum.group_by(requests, &Map.get(&1, "account_configuration_id", ""))
    }
  end

  # Default plugin per tax: %{parent_number => [rows]}.
  defp fetch_plugins([]), do: %{}

  defp fetch_plugins(tax_codes) do
    sql =
      "SELECT acp.account_configuration_id, acp.id AS plugin_id, ac.provider_id, " <>
        "acp.country_code, acp.parent_number, acp.plugin_status, acp.third_party_integration_status " <>
        "FROM account_configuration_plugins acp " <>
        "JOIN account_configurations ac ON ac.id = acp.account_configuration_id " <>
        "WHERE acp.parent_number = ANY(#{pg_array_literal(tax_codes)}) AND acp.is_default IS TRUE " <>
        "ORDER BY acp.parent_number;"

    run_psql("Plugin lookup by tax id (#{length(tax_codes)})", sql)
    |> Enum.group_by(fn r -> Map.get(r, "parent_number", "") end)
  end

  # All einvoice requests for the suppliers' account configurations (register/deregister),
  # newest first per account config. external_correlation_id is NOT the silo entry id in
  # general (mostly internal numeric ids), so we join by account_configuration_id and let
  # build_db_context match per entry by external_correlation_id where it happens to line up.
  defp fetch_requests_by_acct([]), do: []

  defp fetch_requests_by_acct(acct_ids) do
    sql =
      "SELECT eiar.account_configuration_id, eiar.external_correlation_id, " <>
        "eiar.application_type, eiar.status, eiar.created_at, ac.provider_id " <>
        "FROM einvoice_integration_application_requests eiar " <>
        "JOIN account_configurations ac ON ac.id = eiar.account_configuration_id " <>
        "WHERE eiar.account_configuration_id = ANY(#{pg_array_literal(acct_ids)}) " <>
        "ORDER BY eiar.account_configuration_id, eiar.id DESC;"

    run_psql("einvoice requests by account configuration (#{length(acct_ids)})", sql)
  end

  # Build a safe Postgres array literal (e.g. '{"a","b"}') from untrusted values
  # (tax codes come straight from the Invopop API). Each element is double-quoted
  # with " and \ escaped so commas/braces/quotes can't break the array; the whole
  # literal is single-quoted with ' doubled so nothing can break out of the SQL
  # string. Left untyped so Postgres casts it to the column's type (int/text).
  defp pg_array_literal(values) do
    inner =
      Enum.map_join(values, ",", fn v ->
        escaped =
          v
          |> to_string()
          |> String.replace("\\", "\\\\")
          |> String.replace("\"", "\\\"")

        "\"" <> escaped <> "\""
      end)

    "'" <> String.replace("{" <> inner <> "}", "'", "''") <> "'"
  end

  # Show the query, run it via houston, parse the CSV. Returns [] on failure.
  defp run_psql(label, sql) do
    cmd_args = ["psql", "production", "accounting-documents", "--", "-c", sql, "--csv"]
    cmd_str = "houston " <> Enum.map_join(cmd_args, " ", &shell_quote/1)

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== #{label} ===", :reset]))
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))
    IO.puts(IO.ANSI.format([:faint, "Running: #{cmd_str}", :reset]))

    {out, code} = System.cmd("houston", cmd_args, stderr_to_stdout: true)

    if code != 0 do
      IO.puts(IO.ANSI.format([:red, out, :reset]))
      IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} houston failed (exit #{code}).", :reset]))
      []
    else
      parse_csv(out)
    end
  end

  # nil = DB lookup wasn't requested → print nothing.
  defp print_db_inline(_tax, nil), do: :ok

  defp print_db_inline(tax, db) do
    print_plugin_lines(tax, db.plugins)
    print_request_summary(tax, db)
  end

  # Summarize the register/deregister requests tied to this supplier's account config(s),
  # so they show even when no individual silo entry matches by external_correlation_id.
  defp print_request_summary(tax, db) do
    case acct_requests(tax, db) do
      [] ->
        :ok

      reqs ->
        counts = request_counts(reqs)
        latest = reqs |> Enum.map(&Map.get(&1, "created_at", "")) |> Enum.max()

        IO.puts(
          IO.ANSI.format(
            [:faint, "    req  ", :reset] ++
              request_breakdown_ansi(counts) ++
              [:faint, "   latest #{short_ts(latest)}", :reset]
          )
        )
    end
  end

  # Request rows for every account configuration on this supplier's default plugin rows.
  defp acct_requests(tax, db) do
    (Map.get(db.plugins, tax) || [])
    |> Enum.map(&Map.get(&1, "account_configuration_id"))
    |> Enum.flat_map(fn id -> Map.get(db.requests_by_acct, to_string(id), []) end)
  end

  # Counts grouped by {application_type, status}, most frequent first.
  defp request_counts(reqs) do
    reqs
    |> Enum.frequencies_by(fn r -> {to_string(r["application_type"]), to_string(r["status"])} end)
    |> Enum.sort_by(fn {_k, n} -> -n end)
  end

  # Console: each "type/status ×N" segment colored by status so they're easy to tell apart
  # (rejected → red, approved → green, waiting → yellow). Returns IO.ANSI chardata.
  defp request_breakdown_ansi(counts) do
    counts
    |> Enum.map(fn {{type, status}, n} ->
      [request_status_color(status), "#{type}/#{status} ×#{n}", :reset]
    end)
    |> Enum.intersperse("  ")
  end

  # Markdown: emoji-dotted "🟢 register/approved ×2, 🔴 register/rejected ×1" (md has no color).
  defp request_breakdown_text(counts) do
    Enum.map_join(counts, ", ", fn {{type, status}, n} -> "#{status_dot(status)} #{type}/#{status} ×#{n}" end)
  end

  # Emoji proxy for status color in markdown reports (green=ok, red=bad, yellow=in-progress).
  defp status_dot(status) do
    cond do
      status in ["approved", "enabled"] -> "🟢"
      status in ["rejected", "failed", "disabled"] -> "🔴"
      String.contains?(status, ["waiting", "pending"]) -> "🟡"
      true -> "⚪"
    end
  end

  defp request_status_color(status) do
    cond do
      status == "approved" -> :green
      status == "rejected" -> :red
      String.contains?(status, "waiting") -> :yellow
      true -> :faint
    end
  end

  defp print_plugin_lines(tax, _plugins) when not is_binary(tax) or tax == "",
    do: IO.puts(IO.ANSI.format([:faint, "    DB —  (no tax id to look up)", :reset]))

  defp print_plugin_lines(tax, plugins) do
    case Map.get(plugins, tax) do
      rows when rows in [nil, []] ->
        IO.puts(IO.ANSI.format([:bright, :red, "    DB #{@cross} no default plugin row found", :reset]))

      rows ->
        Enum.each(rows, fn r ->
          status = Map.get(r, "plugin_status", "")

          color =
            cond do
              status == "enabled" -> :green
              status == "pending" -> :yellow
              status in ["failed", "disabled"] -> :red
              true -> :faint
            end

          IO.puts(
            IO.ANSI.format([
              color,
              "    DB   plugin=#{status}  third_party=#{Map.get(r, "third_party_integration_status", "")}" <>
                "   provider=#{Map.get(r, "provider_id", "")} acct_cfg=#{Map.get(r, "account_configuration_id", "?")} plugin_id=#{Map.get(r, "plugin_id", "?")} (#{Map.get(r, "country_code", "")})",
              :reset
            ])
          )
        end)
    end
  end

  # CSV parser for houston psql --csv output (drops the correlation_id / timestamp preamble).
  defp parse_csv(text) do
    csv_text =
      text
      |> String.split("\n")
      |> Enum.drop_while(fn line ->
        t = String.trim(line)
        t == "" or Regex.match?(~r/^\d{4}\//, t) or String.starts_with?(t, "correlation_id")
      end)
      |> Enum.join("\n")

    case String.trim(csv_text) do
      "" ->
        []

      cleaned ->
        case NimbleCSV.RFC4180.parse_string(cleaned, skip_headers: false) do
          [] -> []
          [headers | data] -> Enum.map(data, fn vals -> headers |> Enum.zip(vals) |> Map.new() end)
        end
    end
  end

  # --- Helpers ---

  defp prompt_value(label) do
    case IO.gets(label) do
      :eof -> ""
      {:error, _} -> ""
      line -> String.trim(line)
    end
  end

  defp filled?(nil), do: false
  defp filled?(""), do: false

  defp filled?(v) when is_binary(v) do
    t = String.trim(v)
    t != "" and String.downcase(t) != "null"
  end

  defp filled?(_), do: false

  defp truthy?(true), do: true
  defp truthy?("true"), do: true
  defp truthy?(_), do: false

  defp maybe_put(kw, _key, nil), do: kw
  defp maybe_put(kw, _key, false), do: kw
  defp maybe_put(kw, key, value), do: Keyword.put(kw, key, value)

  defp short_id(nil), do: "?"
  defp short_id(id) when is_binary(id), do: String.slice(id, 0, 8)
  defp short_id(id), do: to_string(id)

  defp truncate(nil, _), do: ""

  defp truncate(s, max) when is_binary(s) do
    if String.length(s) > max, do: String.slice(s, 0, max) <> "…", else: s
  end

  defp truncate(s, _), do: to_string(s)

  defp shell_quote(s) do
    if String.contains?(s, [" ", "'", "\"", ";", "(", ")", "*", "$", "`", "{", "}"]) do
      "'" <> String.replace(s, "'", "'\\''") <> "'"
    else
      s
    end
  end
end

InvopopSupplierCheck.run(System.argv())
