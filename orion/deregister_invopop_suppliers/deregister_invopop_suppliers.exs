#!/usr/bin/env elixir

Mix.install([{:req, "~> 0.5"}])

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

defmodule DeregisterSuppliers do
  @moduledoc false
  # -- Purpose: trigger the Invopop "supplier deregistration" workflow for every supplier
  # --          in a workspace (one Transform job per supplier).
  # -- Transport: Invopop REST API (https://api.invopop.com) via Req. No houston needed.
  # -- Auth: Bearer token from INVOPOP_SANDBOX_API_TOKEN, else paste prompt. The token itself
  # --       determines which integration/workspace (ES VeriFactu, ES TicketBAI, IT
  # --       SmartReceipts, ...) we act on.
  # --
  # -- How triggering works (mirrors AccountingDocuments.EInvoicing.Invopop.*.Deregister):
  # --   1. List supplier silo entries:  GET  /silo/v1/entries?folder=suppliers
  # --   2. Fire the workflow per supplier: POST /transform/v1/jobs
  # --        body: {"workflow_id": "<uuid>", "silo_entry_id": "<entry id>"}
  # --
  # -- SAFETY: this script REFUSES to run unless the workspace is a sandbox (staging).
  # --         It prints the workspace and requires you to type its slug to confirm, then a
  # --         final "yes" before any job is created. Use --dry-run to plan without firing.

  @check "✅"
  @cross "❌"
  @wait "⏳"
  @void "⊘"

  @default_base_url "https://api.invopop.com"
  @suppliers_folder "suppliers"
  @page_limit 100
  # Staging-specific vars: this script REQUIRES a sandbox workspace, so its token
  # is kept separate from the production INVOPOP_API_TOKEN used by read-only tools.
  @token_env "INVOPOP_SANDBOX_API_TOKEN"
  @base_url_env "INVOPOP_SANDBOX_API_BASE_URL"

  # Small delay between job POSTs so we don't hammer the API on large workspaces.
  @job_delay_ms 200

  # STAGING deregister workflows: the STRUCTURE (name + env var) lives here; the
  # UUID VALUES live in the repo-root .env (see .env.example), sourced originally
  # from app-accounting-documents/deploy/apps/staging/values.yaml
  # (INVOPOP_ES_CONFIG / INVOPOP_IT_CONFIG -> <authority>.deregister).
  # They are sandbox-workspace-specific; the token you use must belong to the
  # matching workspace. Not validated at runtime — if a workflow is re-created or
  # renamed in Invopop, refresh the value in .env (or pass --workflow-id).
  @workflow_specs [
    {"ES VeriFactu", "INVOPOP_DEREGISTER_WORKFLOW_ES_VERIFACTU"},
    {"ES TicketBAI", "INVOPOP_DEREGISTER_WORKFLOW_ES_TICKETBAI"},
    {"IT SmartReceipts", "INVOPOP_DEREGISTER_WORKFLOW_IT_SMARTRECEIPTS"}
  ]

  # Runtime list of {name, uuid} from env (.env is auto-loaded). Entries whose
  # env var is unset are dropped — pass --workflow-id to use one not listed.
  defp staging_deregister_workflows do
    @workflow_specs
    |> Enum.map(fn {name, key} -> {name, System.get_env(key)} end)
    |> Enum.reject(fn {_name, id} -> id in [nil, ""] end)
  end

  # Silo states that mean the supplier is already gone — skipped unless --include-void.
  @voided_states ~w(void voided cancelled canceled deregistered)

  def run(argv) do
    if "--help" in argv or "-h" in argv, do: (usage(); System.halt(0))

    Dotenv.load()

    opts = %{
      dry_run?: "--dry-run" in argv,
      # One job per silo ENTRY by default — invalidate everything. Pass --latest-only to
      # collapse to a single job per supplier (their most recent entry).
      all_entries?: "--latest-only" not in argv,
      # Void/cancelled suppliers are included by default — we want to invalidate everything.
      # Pass --skip-void to leave already-void suppliers alone.
      include_void?: "--skip-void" not in argv,
      wait: flag_value(argv, "--wait"),
      workflow_id: flag_value(argv, "--workflow-id")
    }

    IO.puts("")
    IO.puts(hl("=== Invopop supplier deregistration ==="))
    if opts.dry_run?, do: IO.puts(IO.ANSI.format([:bright, :yellow, "[DRY RUN] no jobs will be created", :reset]))

    base_url = System.get_env(@base_url_env) || @default_base_url
    token = resolve_token()

    unless filled?(token) do
      IO.puts(err("#{@cross} No API token provided. Aborting."))
      System.halt(1)
    end

    client = build_client(base_url, token)
    IO.puts(faint("Base URL: #{base_url}"))

    workspace = show_workspace(client)

    # --- STAGING GUARD -------------------------------------------------------
    # "make sure it's staging": we only ever run against a sandbox workspace.
    unless workspace && truthy?(workspace.sandbox) do
      IO.puts("")
      IO.puts(err("#{@cross} This workspace is NOT a sandbox (staging)."))
      IO.puts(err("   Refusing to trigger deregistration against a non-sandbox workspace."))
      IO.puts(faint("   The token you use decides the workspace — use a staging/sandbox token."))
      System.halt(1)
    end

    IO.puts(IO.ANSI.format([:bright, :green, "  #{@check} sandbox workspace confirmed", :reset]))

    # --- WORKSPACE CONFIRMATION ---------------------------------------------
    confirm_workspace!(workspace)

    # --- WORKFLOW SELECTION --------------------------------------------------
    workflow_id = choose_workflow(workspace, opts.workflow_id)
    IO.puts(faint("Deregister workflow: #{workflow_id}"))

    # --- FETCH SUPPLIERS -----------------------------------------------------
    IO.puts("")
    IO.puts(faint("Fetching '#{@suppliers_folder}' silo entries..."))
    base_params = [folder: @suppliers_folder, limit: @page_limit]
    entries = fetch_all_suppliers(client, base_params, nil, [], MapSet.new())

    if entries == [] do
      IO.puts(IO.ANSI.format([:yellow, "No supplier entries found. Nothing to do.", :reset]))
      System.halt(0)
    end

    targets = build_targets(entries, opts)
    summarize_targets(entries, targets, opts)

    if targets == [] do
      IO.puts(IO.ANSI.format([:green, "Nothing to deregister after filtering.", :reset]))
      System.halt(0)
    end

    # --- FINAL CONFIRMATION --------------------------------------------------
    unless opts.dry_run? do
      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :yellow, "About to trigger deregistration for #{length(targets)} supplier(s) on workspace '#{workspace.slug}'.", :reset]))
      ans = prompt_value(~s(Type "yes" to fire the workflow jobs: )) |> String.downcase()

      unless ans in ["yes", "y"] do
        IO.puts("Aborted. No jobs created.")
        System.halt(0)
      end
    end

    # --- FIRE ----------------------------------------------------------------
    fire(client, workflow_id, targets, opts)
  end

  # --- Targets: one job per supplier by default (latest entry), or every entry ---

  defp build_targets(entries, opts) do
    entries =
      if opts.include_void?,
        do: entries,
        else: Enum.reject(entries, fn e -> entry_state(e) in @voided_states end)

    cond do
      opts.all_entries? ->
        Enum.map(entries, fn e -> {supplier_label(e), e["id"], entry_state(e)} end)

      true ->
        entries
        |> Enum.group_by(&supplier_key/1)
        |> Enum.map(fn {_key, items} ->
          latest = Enum.max_by(items, fn e -> to_string(e["created_at"]) end)
          {supplier_label(latest), latest["id"], entry_state(latest)}
        end)
    end
    |> Enum.reject(fn {_l, id, _s} -> not filled?(id) end)
    |> Enum.sort_by(fn {label, _id, _s} -> label end)
  end

  defp summarize_targets(all_entries, targets, opts) do
    by_state = Enum.frequencies_by(all_entries, &entry_state/1)

    IO.puts("")
    IO.puts(hl("=== Plan ==="))
    IO.puts("  total silo entries:   #{length(all_entries)}")
    IO.puts(faint("  entries by state:     #{state_breakdown(by_state)}"))
    mode = if opts.all_entries?, do: "one job PER ENTRY", else: "one job per supplier (latest entry)"
    IO.puts("  mode:                 #{mode}")
    IO.puts("  void handling:        #{if opts.include_void?, do: "included", else: "skipped"}")
    IO.puts(IO.ANSI.format([:bright, :white, "  jobs to create:       #{length(targets)}", :reset]))

    IO.puts("")
    IO.puts(hl("=== Targets ==="))

    Enum.each(targets, fn {label, id, state} ->
      mark = if state in @voided_states, do: @void, else: @wait
      IO.puts(IO.ANSI.format([:cyan, "  #{mark} #{label}", :reset, faint("   entry=#{short_id(id)}  state=#{state}")]))
    end)
  end

  # --- Fire the jobs -------------------------------------------------------

  defp fire(client, workflow_id, targets, opts) do
    IO.puts("")
    IO.puts(hl("=== #{if opts.dry_run?, do: "Planned jobs (dry run)", else: "Creating jobs"} ==="))

    path = job_path(opts.wait)

    {ok, failed} =
      targets
      |> Enum.with_index(1)
      |> Enum.reduce({0, 0}, fn {{label, entry_id, _state}, idx}, {ok, failed} ->
        prefix = "  [#{idx}/#{length(targets)}] #{label}"

        body = %{"workflow_id" => workflow_id, "silo_entry_id" => entry_id}

        cond do
          opts.dry_run? ->
            IO.puts(faint("#{prefix}  →  POST #{path} #{inspect(body)}"))
            {ok, failed}

          true ->
            case create_job(client, path, body) do
              {:ok, job_id} ->
                IO.puts(IO.ANSI.format([:green, "#{prefix}  #{@check} job #{short_id(job_id)}", :reset]))
                Process.sleep(@job_delay_ms)
                {ok + 1, failed}

              {:error, reason} ->
                IO.puts(err("#{prefix}  #{@cross} #{inspect(reason)}"))
                Process.sleep(@job_delay_ms)
                {ok, failed + 1}
            end
        end
      end)

    IO.puts("")
    IO.puts(hl("=== Done ==="))

    if opts.dry_run? do
      IO.puts(IO.ANSI.format([:yellow, "  [DRY RUN] #{length(targets)} job(s) would be created. Re-run without --dry-run to fire.", :reset]))
    else
      IO.puts(IO.ANSI.format([:green, "  #{@check} created: #{ok}", :reset]))
      if failed > 0, do: IO.puts(err("  #{@cross} failed:  #{failed}"))
    end
  end

  defp job_path(nil), do: "/transform/v1/jobs"
  defp job_path(wait), do: "/transform/v1/jobs?wait=#{wait}"

  defp create_job(client, path, body) do
    case Req.post(client, url: path, json: body) do
      {:ok, %{status: s, body: resp}} when s in 200..299 ->
        {:ok, (is_map(resp) && resp["id"]) || "?"}

      {:ok, %{status: s, body: resp}} ->
        {:error, "HTTP #{s}: #{extract_error(resp)}"}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp extract_error(body) when is_map(body), do: body["message"] || inspect(body)
  defp extract_error(body), do: inspect(body)

  # --- Workspace ---

  defp show_workspace(client) do
    case Req.get(client, url: "/access/v1/workspace") do
      {:ok, %{status: s, body: w}} when s in 200..299 and is_map(w) ->
        env =
          if truthy?(w["sandbox"]),
            do: IO.ANSI.format([:bright, :yellow, "SANDBOX", :reset]),
            else: IO.ANSI.format([:bright, :red, "PRODUCTION", :reset])

        IO.puts("")
        IO.puts(hl("=== Workspace ==="))
        IO.puts("  name:    #{w["name"]}  (#{env})")
        IO.puts("  slug:    #{w["slug"]}")
        IO.puts("  country: #{w["country"]}")
        IO.puts("  id:      #{w["id"]}")
        IO.puts(faint("  created: #{w["created_at"]}"))

        %{slug: w["slug"], name: w["name"], country: w["country"], id: w["id"], sandbox: w["sandbox"]}

      {:ok, %{status: s, body: body}} ->
        IO.puts(err("#{@cross} Could not fetch workspace (HTTP #{s}): #{inspect(body)}"))
        if s in [401, 403], do: IO.puts(faint("→ Token rejected. Check the API key / integration."))
        System.halt(1)

      {:error, reason} ->
        IO.puts(err("#{@cross} Could not fetch workspace: #{inspect(reason)}"))
        System.halt(1)
    end
  end

  defp confirm_workspace!(workspace) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :yellow, "You are about to act on the workspace above.", :reset]))
    typed = prompt_value("Type the workspace slug '#{workspace.slug}' to continue: ") |> String.trim()

    unless typed == to_string(workspace.slug) and filled?(workspace.slug) do
      IO.puts(err("Slug did not match ('#{typed}' ≠ '#{workspace.slug}'). Aborting."))
      System.halt(1)
    end
  end

  # --- Workflow selection ---

  defp choose_workflow(_workspace, workflow_id) when is_binary(workflow_id) and workflow_id != "" do
    IO.puts(faint("Using workflow id from --workflow-id."))
    workflow_id
  end

  defp choose_workflow(workspace, _nil) do
    suggested = suggest_index(workspace)

    IO.puts("")
    IO.puts(hl("=== Deregistration workflow (staging) ==="))

    staging_deregister_workflows()
    |> Enum.with_index(1)
    |> Enum.each(fn {{name, id}, i} ->
      tag = if i == suggested, do: IO.ANSI.format([:green, "  ← suggested for country=#{workspace.country}", :reset]), else: ""
      IO.puts("  #{i}) #{String.pad_trailing(name, 18)} #{faint(id)}#{tag}")
    end)

    default_hint = if suggested, do: " [default #{suggested}]", else: ""
    raw = prompt_value("Select workflow (1-#{length(staging_deregister_workflows())})#{default_hint}, or paste a UUID: ") |> String.trim()

    resolve_workflow_choice(raw, suggested)
  end

  defp resolve_workflow_choice("", suggested) when is_integer(suggested), do: nth_workflow(suggested)

  defp resolve_workflow_choice(raw, _suggested) do
    cond do
      # a bare index
      raw =~ ~r/^\d+$/ ->
        idx = String.to_integer(raw)

        if idx >= 1 and idx <= length(staging_deregister_workflows()),
          do: nth_workflow(idx),
          else: (IO.puts(err("Invalid selection.")); System.halt(1))

      # looks like a UUID
      String.length(raw) >= 32 and String.contains?(raw, "-") ->
        raw

      true ->
        IO.puts(err("Unrecognized workflow selection: #{raw}"))
        System.halt(1)
    end
  end

  defp nth_workflow(idx) do
    {_name, id} = Enum.at(staging_deregister_workflows(), idx - 1)
    id
  end

  # Suggest a workflow index from the workspace country. ES is ambiguous (VeriFactu vs
  # TicketBAI) so we suggest VeriFactu but leave the choice to the user. Resolved by
  # NAME against the runtime list so it stays correct even if some workflows are
  # unset (and the list is shorter).
  defp suggest_index(%{country: country}) do
    name =
      case country |> to_string() |> String.upcase() do
        "ES" -> "ES VeriFactu"
        "IT" -> "IT SmartReceipts"
        _ -> nil
      end

    with true <- is_binary(name),
         i when is_integer(i) <-
           Enum.find_index(staging_deregister_workflows(), fn {n, _id} -> n == name end) do
      i + 1
    else
      _ -> nil
    end
  end

  defp suggest_index(_), do: nil

  # --- HTTP: suppliers ---

  defp build_client(base_url, token) do
    Req.new(
      base_url: base_url,
      auth: {:bearer, token},
      connect_options: [timeout: 10_000],
      receive_timeout: 15_000
    )
  end

  defp fetch_all_suppliers(client, base_params, cursor, acc, seen_ids) do
    params = if cursor, do: Keyword.put(base_params, :cursor, cursor), else: base_params

    case Req.get(client, url: "/silo/v1/entries", params: params) do
      {:ok, %{status: status, body: body}} when status in 200..299 ->
        entries = extract_entries(body)
        new_entries = Enum.reject(entries, fn e -> MapSet.member?(seen_ids, e["id"]) end)
        seen_ids = Enum.reduce(new_entries, seen_ids, fn e, acc -> MapSet.put(acc, e["id"]) end)
        acc = acc ++ new_entries
        next = is_map(body) && (body["next_cursor"] || body["cursor"])

        IO.puts(faint("  fetched #{length(new_entries)} new (total #{length(acc)})"))

        cond do
          new_entries == [] -> acc
          not filled?(next) or next == cursor -> acc
          true ->
            IO.puts(faint("  …next page in 2s"))
            Process.sleep(2_000)
            fetch_all_suppliers(client, base_params, next, acc, seen_ids)
        end

      {:ok, %{status: status, body: body}} ->
        IO.puts(err("#{@cross} Invopop API returned HTTP #{status}"))
        IO.puts(err(inspect(body)))
        if status in [401, 403], do: IO.puts(faint("→ Token rejected. Check the API key / integration."))
        System.halt(1)

      {:error, reason} ->
        IO.puts(err("#{@cross} Request failed: #{inspect(reason)}"))
        System.halt(1)
    end
  end

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

  # --- Supplier identity (mirrors check_invopop_suppliers.exs) ---

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
      filled?(f.tax) && "tax=#{f.country}#{f.tax}"
    ]
    |> Enum.filter(& &1)
    |> Enum.join("  ")
  end

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
        ])
    }
  end

  defp unwrap_doc(%{"doc" => doc}) when is_map(doc), do: doc
  defp unwrap_doc(m) when is_map(m), do: m
  defp unwrap_doc(_), do: %{}

  defp first_filled(values), do: Enum.find(values, &filled?/1)

  # --- Auth ---

  defp resolve_token do
    case System.get_env(@token_env) do
      v when is_binary(v) and v != "" ->
        IO.puts(faint("Using token from $#{@token_env}."))
        v

      _ ->
        IO.puts(faint("$#{@token_env} not set."))
        prompt_value("Paste Invopop API token (staging): ")
    end
  end

  # --- Small helpers ---

  defp usage do
    IO.puts("""
    deregister_invopop_suppliers — trigger the Invopop supplier-deregistration workflow for all suppliers

    Usage:
      ./ds [flags]

    Auth / target:
      Token comes from $#{@token_env} (else you're prompted). The token decides the
      workspace. Base URL from $#{@base_url_env} (default #{@default_base_url}).
      REFUSES to run unless the workspace is a sandbox (staging).

    Flags:
      --dry-run             List the jobs that would be created; POST nothing
      --latest-only         One job per supplier (their latest entry)
                            (default: one job per silo ENTRY — invalidate everything)
      --skip-void           Skip entries in a void/cancelled state
                            (default: INCLUDE them — invalidate everything)
      --wait N              Pass ?wait=N to the job create call (block up to N seconds)
      --workflow-id UUID    Use this workflow id instead of picking a known staging one
      -h, --help            Show this help
    """)
  end

  defp flag_value(argv, flag) do
    case Enum.find_index(argv, &(&1 == flag)) do
      nil -> nil
      i -> Enum.at(argv, i + 1)
    end
  end

  defp prompt_value(label) do
    case IO.gets(label) do
      :eof -> ""
      {:error, _} -> ""
      line -> String.trim(line)
    end
  end

  defp hl(s), do: IO.ANSI.format([:bright, :white, s, :reset])
  defp faint(s), do: IO.ANSI.format([:faint, s, :reset])
  defp err(s), do: IO.ANSI.format([:bright, :red, s, :reset])

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

  defp short_id(nil), do: "?"
  defp short_id(id) when is_binary(id), do: String.slice(id, 0, 8)
  defp short_id(id), do: to_string(id)

  defp state_breakdown(by_state) do
    by_state
    |> Enum.sort_by(fn {_k, n} -> -n end)
    |> Enum.map_join(", ", fn {state, n} -> "#{if state == "", do: "∅", else: state}=#{n}" end)
  end
end

DeregisterSuppliers.run(System.argv())
