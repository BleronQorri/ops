#!/usr/bin/env elixir

Mix.install([{:req, "~> 0.5"}, {:nimble_csv, "~> 1.2"}])

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

    show_workspace(client)

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

    plugins_by_tax =
      if query_db?, do: fetch_plugins(report_tax_codes(classified, problems_only?)), else: nil

    grouped_report(classified, problems_only?, plugins_by_tax)

    if write_report?,
      do: write_markdown_report(classified, problems_only?, plugins_by_tax, created_after)
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
      IO.puts("  DB (plugin by tax, is_default):")
      IO.puts("    DB ▸ …                 default plugin row (acct_config / plugin / provider / status)")
      IO.puts(IO.ANSI.format([:red, "    DB #{@cross} …", :reset, "                 no default plugin row found"]))
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

      {:ok, %{status: s, body: body}} ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  Could not fetch workspace (HTTP #{s}): #{inspect(body)}", :reset]))

      {:error, reason} ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  Could not fetch workspace: #{inspect(reason)}", :reset]))
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

  defp grouped_report(classified, problems_only?, plugins_by_tax) do
    groups = build_groups(classified, problems_only?)
    request_count = groups |> Enum.map(fn {items, _} -> length(items) end) |> Enum.sum()

    print_legend(plugins_by_tax != nil)

    IO.puts("")
    title = if problems_only?, do: "Report — problematic suppliers", else: "Report — all suppliers"
    IO.puts(IO.ANSI.format([:bright, :white, "=== #{title} (#{length(groups)} suppliers, #{request_count} requests) ===", :reset]))

    if groups == [] do
      IO.puts(IO.ANSI.format([:green, "  #{@check} nothing to report", :reset]))
    else
      Enum.each(groups, fn {items, _latest} ->
        {_c, first} = hd(items)
        reasons = problem_reasons(items)
        plural = if length(items) == 1, do: "", else: "s"
        header = [:bright, :cyan, "▸ #{supplier_label(first)}  (#{length(items)} request#{plural})", :reset]
        flag = if reasons == "", do: [], else: [:bright, :red, "  ⚠️  #{reasons}", :reset]

        IO.puts("")
        IO.puts(IO.ANSI.format(header ++ flag))
        print_plugins_inline(supplier_fields(first).tax, plugins_by_tax)
        Enum.each(items, fn {class, e} -> print_entry(class, e) end)
      end)

      unless problems_only?, do: IO.puts(IO.ANSI.format([:faint, "\n(pass --problems to show only problematic suppliers)", :reset]))
    end
  end

  # --- Markdown report export ---

  defp write_markdown_report(classified, problems_only?, plugins_by_tax, created_after) do
    groups = build_groups(classified, problems_only?)
    counts = Enum.frequencies_by(classified, fn {c, _} -> c end)
    now = DateTime.utc_now()
    stamp = now |> DateTime.to_iso8601() |> String.replace(~r/[:.]/, "-")
    path = "invopop_report_#{stamp}.md"

    request_count = groups |> Enum.map(fn {items, _} -> length(items) end) |> Enum.sum()

    head = [
      "# Invopop supplier report\n\n",
      "- Generated: #{DateTime.to_iso8601(now)} (UTC)\n",
      "- Date range: #{if created_after, do: "created_at >= #{created_after}", else: "all time"}\n",
      "- Filter: #{if problems_only?, do: "problematic suppliers only", else: "all suppliers"}\n",
      "- DB lookup: #{if plugins_by_tax, do: "yes", else: "no"}\n",
      "- Suppliers: #{length(groups)} — Requests: #{request_count}\n",
      "- Totals: ok #{Map.get(counts, :ok, 0)}, pending #{Map.get(counts, :pending, 0)}, " <>
        "error #{Map.get(counts, :error, 0)}, voided #{Map.get(counts, :voided, 0)}, " <>
        "unknown #{Map.get(counts, :unknown, 0)} (#{length(classified)} entries)\n\n"
    ]

    body =
      if groups == [],
        do: ["_Nothing to report._\n"],
        else: Enum.map(groups, fn {items, _} -> md_supplier(items, plugins_by_tax) end)

    case File.write(path, IO.iodata_to_binary([head, body])) do
      :ok ->
        IO.puts("")
        IO.puts(IO.ANSI.format([:bright, :green, "#{@check} Report written: #{path}", :reset]))

      {:error, reason} ->
        IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} Could not write report: #{inspect(reason)}", :reset]))
    end
  end

  defp md_supplier(items, plugins_by_tax) do
    {_c, first} = hd(items)
    reasons = problem_reasons(items)
    flag = if reasons == "", do: "", else: " — ⚠️ #{reasons}"

    rows =
      Enum.map(items, fn {_class, e} ->
        msg =
          case e["faults"] || [] do
            [f | _] -> "#{f["provider"]}/#{f["code"]}: #{truncate(f["message"], 80)}"
            _ -> ""
          end

        "| #{e["state"]} | #{e["created_at"]} | #{length(e["faults"] || [])} | #{e["id"]} | #{md_escape(msg)} |\n"
      end)

    [
      "## #{md_escape(supplier_label(first))}#{flag}\n\n",
      md_db(supplier_fields(first).tax, plugins_by_tax),
      "| state | created | faults | id | first fault |\n",
      "|---|---|---|---|---|\n",
      rows,
      "\n"
    ]
  end

  defp md_db(_tax, nil), do: ""

  defp md_db(tax, by_tax) do
    cond do
      not filled?(tax) ->
        "_DB: no tax id to look up_\n\n"

      true ->
        case Map.get(by_tax, tax) do
          rows when rows in [nil, []] ->
            "**DB: ❌ no default plugin row found**\n\n"

          rows ->
            lines =
              Enum.map(rows, fn r ->
                "- DB: acct_config_id=#{Map.get(r, "account_configuration_id", "?")} " <>
                  "plugin_id=#{Map.get(r, "plugin_id", "?")} " <>
                  "provider_id=#{Map.get(r, "provider_id", "?")} " <>
                  "country=#{Map.get(r, "country_code", "")} " <>
                  "plugin=#{Map.get(r, "plugin_status", "")} " <>
                  "third_party=#{Map.get(r, "third_party_integration_status", "")}\n"
              end)

            [lines, "\n"]
        end
    end
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

  defp print_entry(class, e) do
    {color, mark} =
      case class do
        :ok -> {:green, @check}
        :pending -> {:yellow, @wait}
        :error -> {:red, @cross}
        :voided -> {:light_black, @void}
        _ -> {:faint, "?"}
      end

    faults = e["faults"] || []

    flags =
      [truthy?(e["invalid"]) && "invalid", truthy?(e["draft"]) && "draft"]
      |> Enum.filter(& &1)
      |> case do
        [] -> ""
        list -> " [#{Enum.join(list, ",")}]"
      end

    IO.puts(
      IO.ANSI.format([
        color,
        "  #{mark} #{short_id(e["id"])}  state=#{e["state"] || "?"}#{flags}  faults=#{length(faults)}  key=#{e["key"]}  created=#{e["created_at"]}  upd=#{e["updated_at"]}",
        :reset
      ])
    )

    # error → list every fault under the entry
    Enum.each(faults, fn f ->
      IO.puts(IO.ANSI.format([:red, "      ↳ [#{f["provider"]}] #{f["code"]}: #{truncate(f["message"], 120)}", :reset]))
    end)
  end

  # --- Optional: look up account_configuration_plugins by tax id via houston psql ---

  # tax ids of the suppliers shown in the report (problematic ones if filtered)
  defp report_tax_codes(classified, problems_only?) do
    classified
    |> Enum.group_by(fn {_c, e} -> supplier_key(e) end)
    |> Enum.filter(fn {_k, items} -> not problems_only? or problematic_supplier?(items) end)
    |> Enum.map(fn {_k, items} -> items |> hd() |> elem(1) |> supplier_fields() |> Map.get(:tax) end)
    |> Enum.filter(&filled?/1)
    |> Enum.uniq()
  end

  # Runs one houston psql query for all tax codes and returns a %{tax => [rows]} map
  # (so the report can show each supplier's plugin row inline). Returns %{} on failure.
  defp fetch_plugins([]) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:yellow, "No tax ids available to look up in the DB.", :reset]))
    %{}
  end

  defp fetch_plugins(tax_codes) do
    tax_list = Enum.map_join(tax_codes, ",", & &1)

    sql =
      "SELECT acp.account_configuration_id, acp.id AS plugin_id, acp.provider_id, " <>
        "acp.country_code, acp.parent_number, acp.plugin_status, acp.third_party_integration_status " <>
        "FROM account_configuration_plugins acp " <>
        "WHERE acp.parent_number = ANY('{#{tax_list}}') AND acp.is_default IS TRUE " <>
        "ORDER BY acp.parent_number;"

    cmd_args = ["psql", "production", "accounting-documents", "--", "-c", sql, "--csv"]
    cmd_str = "houston " <> Enum.map_join(cmd_args, " ", &shell_quote/1)

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Plugin lookup by tax id (#{length(tax_codes)}) ===", :reset]))
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))
    IO.puts(IO.ANSI.format([:faint, "Running: #{cmd_str}", :reset]))

    {out, code} = System.cmd("houston", cmd_args, stderr_to_stdout: true)

    if code != 0 do
      IO.puts(IO.ANSI.format([:red, out, :reset]))
      IO.puts(IO.ANSI.format([:bright, :red, "#{@cross} houston failed (exit #{code}).", :reset]))
      %{}
    else
      out |> parse_csv() |> Enum.group_by(fn r -> Map.get(r, "parent_number", "") end)
    end
  end

  # nil = DB lookup wasn't requested → print nothing.
  defp print_plugins_inline(_tax, nil), do: :ok

  defp print_plugins_inline(tax, by_tax) do
    cond do
      not filled?(tax) ->
        IO.puts(IO.ANSI.format([:faint, "  DB —  (no tax id to look up)", :reset]))

      true ->
        case Map.get(by_tax, tax) do
          rows when rows in [nil, []] ->
            IO.puts(IO.ANSI.format([:bright, :red, "  DB #{@cross} NO default plugin row found", :reset]))

          rows ->
            Enum.each(rows, &print_plugin_row/1)
        end
    end
  end

  defp print_plugin_row(r) do
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
        "  DB ▸ acct_config_id=#{Map.get(r, "account_configuration_id", "?")} " <>
          "plugin_id=#{Map.get(r, "plugin_id", "?")} " <>
          "provider_id=#{Map.get(r, "provider_id", "?")} " <>
          "country=#{Map.get(r, "country_code", "")} " <>
          "plugin=#{status} " <>
          "third_party=#{Map.get(r, "third_party_integration_status", "")}",
        :reset
      ])
    )
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
