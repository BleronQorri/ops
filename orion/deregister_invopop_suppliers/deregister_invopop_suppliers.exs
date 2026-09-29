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
  # --         It is a dry run unless --dry-run false is passed or picked: the plan is
  # --         listed and nothing is POSTed. With false, the jobs are fired only after a
  # --         typed "yes" that names the workspace. Without a terminal it asks nothing
  # --         and is always a dry run.

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

    opts = parse_args(argv)
    Process.put(:terminal, terminal_device())
    opts = ask_missing(opts)

    IO.puts("")
    IO.puts(hl("=== Invopop supplier deregistration — SANDBOX workspaces only ==="))

    if opts.dry_run?,
      do: IO.puts(IO.ANSI.format([:bright, :yellow, "[DRY RUN] list the jobs, create none — --dry-run false fires them", :reset])),
      else: IO.puts(IO.ANSI.format([:bright, :yellow, ~s(LIVE: the jobs are fired after a typed "yes"), :reset]))

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

    # --- CONFIRMATION: the one write, confirmed once (a sandbox) --------------
    unless opts.dry_run? do
      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :yellow, "About to trigger deregistration for #{length(targets)} supplier(s) on sandbox workspace '#{workspace.name}' (#{workspace.slug}).", :reset]))
      ans = prompt_value(~s(Type "yes" to fire the workflow jobs: )) |> String.downcase()

      unless ans == "yes" do
        IO.puts("Aborted. No jobs created.")
        System.halt(1)
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
      IO.puts(IO.ANSI.format([:yellow, "  [DRY RUN] #{length(targets)} job(s) would be created. Re-run with --dry-run false to fire.", :reset]))
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

  # --- Workflow selection ---

  defp choose_workflow(_workspace, workflow_id) when is_binary(workflow_id) and workflow_id != "" do
    IO.puts(faint("Using workflow id from --workflow-id."))
    workflow_id
  end

  # Without a terminal nothing is asked: the workflow suggested for the
  # workspace's country is taken (it is a dry run), or --workflow-id must say.
  defp choose_workflow(workspace, _nil) do
    suggested = suggest_index(workspace)
    workflows = staging_deregister_workflows()

    cond do
      terminal() == nil and is_integer(suggested) ->
        {name, id} = Enum.at(workflows, suggested - 1)
        IO.puts(faint("No terminal: taking #{name}, suggested for country=#{workspace.country} (--workflow-id picks another)."))
        id

      terminal() == nil ->
        usage_error("no deregister workflow suggested for country=#{workspace.country}, and no terminal to ask on — pass --workflow-id UUID")

      workflows == [] ->
        IO.puts(faint("No deregister workflow configured in the environment."))
        resolve_workflow_uuid(prompt_value("Paste the deregister workflow UUID: ") |> String.trim())

      true ->
        options =
          workflows
          |> Enum.with_index(1)
          |> Enum.map(fn {{name, id}, i} ->
            note = if i == suggested, do: "#{id} · suggested for country=#{workspace.country}", else: id
            {id, name, note}
          end)

        IO.puts("")

        case choose("Deregistration workflow (staging)?", options ++ [{:other, "another", "paste its UUID"}], (suggested || 1) - 1) do
          :other -> resolve_workflow_uuid(prompt_value("Paste the deregister workflow UUID: ") |> String.trim())
          id -> id
        end
    end
  end

  defp resolve_workflow_uuid(raw) do
    if String.length(raw) >= 32 and String.contains?(raw, "-") do
      raw
    else
      IO.puts(err("Unrecognized workflow selection: #{raw}"))
      System.halt(1)
    end
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
        if terminal() == nil,
          do: usage_error("$#{@token_env} is not set, and there is no terminal to ask for it on")

        IO.puts(faint("$#{@token_env} not set."))
        prompt_value("Paste Invopop API token (staging): ")
    end
  end

  # --- Arguments ---

  defp parse_args(argv) do
    init = %{
      # nil = not given: asked on a terminal, true without one.
      dry_run?: nil,
      # One job per silo ENTRY by default — invalidate everything. Pass --latest-only to
      # collapse to a single job per supplier (their most recent entry).
      all_entries?: true,
      # Void/cancelled suppliers are included by default — we want to invalidate everything.
      # Pass --skip-void to leave already-void suppliers alone.
      include_void?: true,
      wait: nil,
      workflow_id: nil
    }

    do_parse(argv, init)
  end

  defp do_parse([], acc), do: acc

  # A bare --dry-run means true; a value after it says which.
  defp do_parse(["--dry-run", v | rest], acc) when v in ["true", "false"],
    do: do_parse(rest, %{acc | dry_run?: v == "true"})

  defp do_parse(["--dry-run" | rest], acc), do: do_parse(rest, %{acc | dry_run?: true})
  defp do_parse(["--dry-run=" <> v | rest], acc), do: do_parse(rest, %{acc | dry_run?: bool_of(v)})
  defp do_parse(["--latest-only" | rest], acc), do: do_parse(rest, %{acc | all_entries?: false})
  defp do_parse(["--skip-void" | rest], acc), do: do_parse(rest, %{acc | include_void?: false})
  defp do_parse(["--wait", v | rest], acc), do: do_parse(rest, %{acc | wait: v})
  defp do_parse(["--workflow-id", v | rest], acc), do: do_parse(rest, %{acc | workflow_id: v})
  defp do_parse([flag], _acc) when flag in ["--wait", "--workflow-id"], do: usage_error("#{flag} takes a value")
  defp do_parse(["-" <> _ = flag | _], _acc), do: usage_error("unknown flag: #{flag}")
  defp do_parse([arg | _], _acc), do: usage_error("unexpected argument: #{arg} (this script takes flags only)")

  defp bool_of("true"), do: true
  defp bool_of("false"), do: false
  defp bool_of(v), do: usage_error("--dry-run takes true or false, got #{inspect(v)}")

  # --- Asking the operator ---

  # Asks for whatever the flags left out. Without a terminal nothing is asked and
  # the run is a dry run.
  defp ask_missing(opts) do
    cond do
      terminal() == nil ->
        if opts.dry_run? == false,
          do: usage_error("--dry-run false needs a terminal: the write is confirmed by hand")

        %{opts | dry_run?: true}

      opts.dry_run? == nil ->
        IO.puts("")

        dry_run? =
          choose("Dry run?", [
            {true, "true", "list the jobs that would be created; POST nothing"},
            {false, "false", ~s(fire the jobs, after a typed "yes")}
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
  # takes the highlighted one, esc or Ctrl+C stops. `at` is highlighted to begin
  # with (the first, unless said). Each keystroke repaints the options in place —
  # the cursor goes back up and every line clears only its own tail, one write per
  # frame — so the list never blanks between frames. The terminal's settings
  # (saved with stty -g, restored exactly) and its cursor come back however the
  # choice ends. Options are {value, label, note}.
  defp choose(question, options, at \\ 0) do
    dev = terminal()
    IO.puts("  #{hl(question)}  #{faint("↑↓ move · enter picks · esc stops")}")
    {saved, 0} = stty(dev, "-g")

    result =
      try do
        stty(dev, "raw -echo")
        IO.write("\e[?25l")
        draw(options, at, true)
        pick(options, at)
      after
        stty(dev, "'#{String.trim(saved)}'")
        IO.write("\e[?25h")
      end

    case result do
      {:ok, value} ->
        value

      :stop ->
        IO.puts(err("✗ stopped at a prompt — no jobs created."))
        System.halt(1)
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

  # The call was wrong: exit 2.
  defp usage_error(msg) do
    IO.puts(:stderr, err("#{@cross} #{msg}"))
    System.halt(2)
  end

  # --- Small helpers ---

  defp usage do
    IO.puts("""
    deregister_invopop_suppliers — trigger the Invopop supplier-deregistration workflow for all suppliers

    Usage:
      ./deregister_invopop_suppliers.exs [flags]

    Sandbox only: REFUSES to run unless the workspace is a sandbox (staging), so it
    never asks which environment.

    On a terminal it asks for what is left out: whether to dry run (a picker: ↑↓ or
    j/k, enter picks, esc stops), the token when $#{@token_env} is unset, and the
    deregister workflow. Firing the jobs is confirmed by typing "yes". Without a
    terminal it asks nothing: the token must be set, the workflow is --workflow-id
    or the one suggested for the workspace's country, and the run is a dry run.

    Auth / target:
      Token comes from $#{@token_env} (else you're asked). The token decides the
      workspace. Base URL from $#{@base_url_env} (default #{@default_base_url}).

    Flags:
      --dry-run BOOL        true (the default; a bare --dry-run means true): list the
                            jobs that would be created, POST nothing. false: fire them,
                            after a typed "yes"
      --latest-only         One job per supplier (their latest entry)
                            (default: one job per silo ENTRY — invalidate everything)
      --skip-void           Skip entries in a void/cancelled state
                            (default: INCLUDE them — invalidate everything)
      --wait N              Pass ?wait=N to the job create call (block up to N seconds)
      --workflow-id UUID    Use this workflow id instead of picking a known staging one
      -h, --help            Show this help

    Exit codes: 0 done, 1 a request failed or the operator stopped it, 2 the call was wrong.
    """)
  end

  defp prompt_value(label) do
    case IO.gets(label) do
      :eof -> ""
      {:error, _} -> ""
      line -> String.trim(line)
    end
  end

  defp hl(s), do: IO.ANSI.format([:bright, :white, s, :reset]) |> IO.chardata_to_string()
  defp faint(s), do: IO.ANSI.format([:faint, s, :reset]) |> IO.chardata_to_string()
  defp err(s), do: IO.ANSI.format([:bright, :red, s, :reset]) |> IO.chardata_to_string()
  defp cmd(s), do: IO.ANSI.format([:yellow, s, :reset]) |> IO.chardata_to_string()

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
