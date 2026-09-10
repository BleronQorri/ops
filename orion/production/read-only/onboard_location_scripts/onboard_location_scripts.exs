#!/usr/bin/env elixir

# DEPRECATED — Billing Profiles migration.
# The onboarding model this checks (per-location billing details on shedul +
# account_configurations) is being replaced by Billing Profiles in
# app-accounting-documents. The Q1/Q2 checks and task suggestions target the
# pre-migration schema. Kept for reference / legacy providers only — do not rely
# on it for new onboarding. Remove once the migration completes.

Mix.install([{:nimble_csv, "~> 1.2"}])

defmodule Onboard do
  @loc_fields ~w(name city_name state district postal_code street_address building_number vat_number company_registration_number)
  @check "✅"
  @cross "❌"

  def run(provider_id) do
    deprecation_gate()

    IO.puts("""
    -- Purpose: provider onboarding check.
    -- Databases:
    --   shedul              → provider_billing_informations, location_billing_details, locations
    --   accounting-documents → account_configuration_plugins, account_configurations (poll target)
    -- Step 1: Q1 (shedul) → check tax_number + company_registration_number.
    -- Step 2: Q2 (shedul) → per-location field checks + houston task suggestions.
    -- Polling (accounting-documents) → after revoke / onboard tasks.
    """)

    q1_sql = q1_sql(provider_id)
    pbi_rows = run_or_paste("Q1", q1_sql)
    show_provider(pbi_rows)

    q2_sql = q2_sql(provider_id)
    loc_rows = run_or_paste("Q2", q2_sql)

    if loc_rows == [] do
      IO.puts("\n#{@cross} no location rows parsed")
    else
      show_locations(loc_rows)
      suggest_tasks(loc_rows)
      gate_next_stage(loc_rows)
      verify_default_location(pbi_rows, loc_rows)
      gate_revoke_onboarding(provider_id, pbi_rows, loc_rows)
    end
  end

  defp deprecation_gate do
    IO.puts(IO.ANSI.format([:bright, :yellow, "\n" <> String.duplicate("=", 60), :reset]))
    IO.puts(IO.ANSI.format([:bright, :yellow, "  ⚠️  DEPRECATED — Billing Profiles migration", :reset]))
    IO.puts(IO.ANSI.format([:yellow, "  This checks the pre-migration onboarding model. It does not", :reset]))
    IO.puts(IO.ANSI.format([:yellow, "  reflect Billing Profiles. Reference / legacy providers only.", :reset]))
    IO.puts(IO.ANSI.format([:bright, :yellow, String.duplicate("=", 60), :reset]))

    answer =
      case IO.gets("Continue anyway? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    unless answer in ["y", "yes"] do
      IO.puts("Aborted.")
      System.halt(0)
    end
  end

  defp gate_revoke_onboarding(provider_id, pbi_rows, loc_rows) do
    answer =
      case IO.gets("\nDefault location verified with Nina? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if answer in ["y", "yes"] do
      company_name = prompt_value("company_name: ")

      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :white, "=== Stage 4: revoke_onboarding ===", :reset]))

      cmd = """
      houston task run accounting-documents-web revoke_onboarding \\
        -p OTP="123456" \\
        -p COMPANY_NAME="#{company_name}" \\
        -p PROVIDER_ID="#{provider_id}"\
      """

      IO.puts("")
      IO.puts(IO.ANSI.format([:yellow, cmd, :reset]))

      prompt_and_poll("revoke (provider #{provider_id})", provider_id, "disabled", "revoked", :default)

      stage_update_provider_crn(provider_id)
      stage_onboard_to_ksa(provider_id, company_name, pbi_rows, loc_rows)
    else
      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :red, "❌ Default location not verified. Stop. Confirm with Nina before proceeding.", :reset]))
    end
  end

  defp stage_update_provider_crn(provider_id) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Stage 5: Set provider_billing_informations CRN to default location CRN ===", :reset]))

    IO.puts("Goal: provider_billing_informations.company_registration_number := <default_location_CRN> for provider_id=#{provider_id}")
    IO.puts(IO.ANSI.format([:faint, "Real task: TBD (no houston task exists yet).", :reset]))

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "Workaround — Unleash flag ORION_CAN_EDIT_BILLING_DETAILS:", :reset]))

    workaround = """
    1. Open: https://unleash.fresha.com/projects/default/features/ORION_CAN_EDIT_BILLING_DETAILS
    2. Allow provider_id #{provider_id} on the PRODUCTION flag
       (edit strategy → add provider #{provider_id} to allow-list)
    3. Edit billing details to include the default CRN
       (set provider_billing_informations.company_registration_number for provider #{provider_id})
    4. Disable the flag for provider #{provider_id} (remove from allow-list / turn off PRODUCTION env)
    """

    IO.puts(IO.ANSI.format([:cyan, workaround, :reset]))
  end

  defp stage_onboard_to_ksa(provider_id, company_name, pbi_rows, loc_rows) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Stage 6: onboard_provider_to_ksa (with proper CRN) ===", :reset]))

    employee_id = prompt_value("employee_id: ")
    otp = prompt_value("OTP: ")

    if otp == "" do
      IO.puts(IO.ANSI.format([:bright, :red, "❌ OTP required. Skipping onboard command.", :reset]))
    else
      cmd = """
      houston task run accounting-documents-web onboard_provider_to_ksa \\
        -p OTP="#{otp}" \\
        -p PROVIDER_ID="#{provider_id}" \\
        -p EMPLOYEE_ID="#{employee_id}" \\
        -p COMPANY_NAME="#{company_name}"\
      """

      IO.puts("")
      IO.puts(IO.ANSI.format([:yellow, cmd, :reset]))

      prompt_and_poll("onboard provider #{provider_id}", provider_id, "enabled", "enabled", :default)

      _ = employee_id
      stage_onboard_locations(provider_id, company_name, pbi_rows, loc_rows)
    end
  end

  defp stage_onboard_locations(provider_id, company_name, pbi_rows, loc_rows) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Stage 7: onboard non-default locations ===", :reset]))

    provider_crn =
      case pbi_rows do
        [row | _] -> String.trim(Map.get(row, "company_registration_number", ""))
        _ -> ""
      end

    {default_ids, non_default} =
      if filled?(provider_crn) do
        Enum.split_with(loc_rows, fn r ->
          String.trim(Map.get(r, "company_registration_number", "")) == provider_crn
        end)
      else
        {[], loc_rows}
      end

    case default_ids do
      [d] ->
        IO.puts(IO.ANSI.format([:faint, "Auto-skipping default location_id=#{Map.get(d, "location_id", "?")} (CRN match).", :reset]))

      [] ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  No location matches provider CRN — onboarding all locations.", :reset]))

      many ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  #{length(many)} locations match provider CRN — all skipped:", :reset]))

        Enum.each(many, fn d ->
          IO.puts("  - location_id=#{Map.get(d, "location_id", "?")} (#{Map.get(d, "name", "")})")
        end)
    end

    if non_default == [] do
      IO.puts(IO.ANSI.format([:yellow, "No non-default locations. Nothing to onboard.", :reset]))
    else
      Enum.each(non_default, fn row ->
        loc_id = Map.get(row, "location_id", "")
        name = Map.get(row, "name", "")

        IO.puts("")
        IO.puts(IO.ANSI.format([:bright, :white, "--- location_id=#{loc_id} (#{name}) ---", :reset]))

        ans =
          case IO.gets("Onboard this location? (y/N): ") do
            :eof -> ""
            {:error, _} -> ""
            line -> line |> String.trim() |> String.downcase()
          end

        if ans in ["y", "yes"] do
          otp = prompt_value("OTP for location #{loc_id}: ")

          if otp == "" do
            IO.puts(IO.ANSI.format([:red, "❌ OTP empty. Skipping #{loc_id}.", :reset]))
          else
            cmd = """
            houston task run accounting-documents-web onboard_location_to_ksa \\
              -p OTP="#{otp}" \\
              -p COMPANY_NAME="#{company_name}" \\
              -p PROVIDER_ID="#{provider_id}" \\
              -p LOCATION_ID="#{loc_id}"\
            """

            IO.puts(IO.ANSI.format([:yellow, cmd, :reset]))

            loc_crn = Map.get(row, "company_registration_number", "")
            prompt_and_poll("onboard location #{loc_id}", provider_id, "enabled", "enabled", {:crn, loc_crn})
          end
        else
          IO.puts(IO.ANSI.format([:faint, "Skipped #{loc_id}.", :reset]))
        end
      end)
    end
  end

  defp prompt_value(label) do
    case IO.gets(label) do
      :eof -> ""
      {:error, _} -> ""
      line -> String.trim(line)
    end
  end

  defp verify_default_location(pbi_rows, loc_rows) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Stage 3: Default location check ===", :reset]))

    provider_crn =
      case pbi_rows do
        [row | _] -> Map.get(row, "company_registration_number", "")
        _ -> ""
      end

    cond do
      not filled?(provider_crn) ->
        IO.puts(IO.ANSI.format([:red, "#{@cross} provider CRN missing — cannot match against locations.", :reset]))

      true ->
        IO.puts("Provider CRN: #{provider_crn}")

        matches =
          Enum.filter(loc_rows, fn row ->
            String.trim(Map.get(row, "company_registration_number", "")) == String.trim(provider_crn)
          end)

        case matches do
          [] ->
            IO.puts(IO.ANSI.format([:red, "#{@cross} No location has CRN #{provider_crn}.", :reset]))

          [match] ->
            IO.puts(
              IO.ANSI.format([
                :green,
                "#{@check} 1 location matches provider CRN — location_id=#{Map.get(match, "location_id", "?")} (#{Map.get(match, "name", "")})",
                :reset
              ])
            )

          many ->
            IO.puts(IO.ANSI.format([:yellow, "⚠️  #{length(many)} locations match provider CRN:", :reset]))

            Enum.each(many, fn m ->
              IO.puts("  - location_id=#{Map.get(m, "location_id", "?")} (#{Map.get(m, "name", "")})")
            end)
        end
    end

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :red, "⚠️  Verify with Nina which location should be the default. Do not proceed alone.", :reset]))
  end

  defp gate_next_stage(rows) do
    answer =
      case IO.gets("\nDetails verified with Nina? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if answer in ["y", "yes"] do
      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :green, "✅ Verified. Proceeding to next stage — real run (DRY_RUN=false):", :reset]))

      Enum.each(rows, fn row ->
        cmd = """
        houston task run partners-app update_location_billing_details \\
          -p LOCATION_ID="#{Map.get(row, "location_id", "")}" \\
          -p NAME="#{Map.get(row, "name", "")}" \\
          -p CITY_NAME="#{Map.get(row, "city_name", "")}" \\
          -p STATE="#{Map.get(row, "state", "")}" \\
          -p DISTRICT="#{Map.get(row, "district", "")}" \\
          -p POSTAL_CODE="#{Map.get(row, "postal_code", "")}" \\
          -p STREET_ADDRESS="#{Map.get(row, "street_address", "")}" \\
          -p BUILDING_NUMBER="#{Map.get(row, "building_number", "")}" \\
          -p VAT_NUMBER="#{Map.get(row, "vat_number", "")}" \\
          -p COMPANY_REGISTRATION_NUMBER="#{Map.get(row, "company_registration_number", "")}" \\
          -p DRY_RUN="false"\
        """

        IO.puts("")
        IO.puts(IO.ANSI.format([:green, cmd, :reset]))
      end)
    else
      IO.puts("")
      IO.puts(IO.ANSI.format([:bright, :red, "❌ Not verified. Fill missing fields, confirm with Nina, then re-run.", :reset]))
    end
  end

  defp q1_sql(pid) do
    "SELECT provider_id, tax_number, company_registration_number FROM provider_billing_informations WHERE provider_id = '#{pid}' AND valid_to IS NULL;"
  end

  defp q2_sql(pid) do
    "SELECT location_id, name, city_name, state, district, postal_code, street_address, building_number, vat_number, company_registration_number FROM location_billing_details WHERE location_id IN (SELECT id FROM locations WHERE provider_id = '#{pid}');"
  end

  defp acp_sql(provider_id) do
    "SELECT ac.provider_id, acp.branch_number AS crn, acp.is_default, 'loc_' || acp.id AS loc_acp_id, acp.plugin_status, acp.third_party_integration_status FROM account_configuration_plugins acp LEFT JOIN account_configurations ac ON ac.id = acp.account_configuration_id WHERE ac.provider_id = '#{provider_id}';"
  end

  defp prompt_and_poll(label, provider_id, expected_plugin, expected_third_party, target) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Poll: #{label} (db: accounting-documents) ===", :reset]))
    sql = acp_sql(provider_id)
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))

    target_label =
      case target do
        :default -> "row where is_default=true"
        {:crn, c} -> "row where crn=#{c}"
        :all -> "all rows"
      end

    IO.puts("Target: #{target_label}")
    IO.puts("Expected: plugin_status=#{expected_plugin}, third_party_integration_status=#{expected_third_party}")

    answer =
      case IO.gets("Poll account_configuration_plugins (accounting-documents) every 20s? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if answer in ["y", "yes"] do
      poll_acp(provider_id, expected_plugin, expected_third_party, target, 1, 30)
    else
      manual_confirm(expected_plugin, expected_third_party)
    end
  end

  defp manual_confirm(expected_plugin, expected_third_party) do
    ans =
      case IO.gets("Has state reached plugin=#{expected_plugin}, third_party=#{expected_third_party}? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if ans in ["y", "yes"] do
      IO.puts(IO.ANSI.format([:bright, :green, "✅ Confirmed manually. Proceeding.", :reset]))
    else
      IO.puts(IO.ANSI.format([:yellow, "⏳ Still waiting. Re-checking...", :reset]))
      manual_confirm(expected_plugin, expected_third_party)
    end
  end

  defp poll_acp(provider_id, expected_plugin, expected_third_party, target, attempt, max_attempts) do
    sql = acp_sql(provider_id)
    cmd_args = ["psql", "production", "accounting-documents", "--", "-c", sql, "--csv"]

    IO.puts("")
    IO.puts(IO.ANSI.format([:faint, "Poll ##{attempt}/#{max_attempts} — houston psql production accounting-documents...", :reset]))
    {out, code} = System.cmd("houston", cmd_args, stderr_to_stdout: true)

    if code != 0 do
      IO.puts(IO.ANSI.format([:red, out, :reset]))
      IO.puts(IO.ANSI.format([:bright, :red, "❌ houston failed during poll. Aborting.", :reset]))
    else
      rows = parse_csv(out)
      target_rows = filter_target(rows, target)

      cond do
        rows == [] ->
          IO.puts(IO.ANSI.format([:yellow, "⚠️  No acp rows returned.", :reset]))

        target_rows == [] ->
          IO.puts(IO.ANSI.format([:yellow, "⚠️  No row matches target. All rows:", :reset]))
          Enum.each(rows, &print_row(&1, expected_plugin, expected_third_party))

        true ->
          Enum.each(target_rows, &print_row(&1, expected_plugin, expected_third_party))
      end

      all_match =
        target_rows != [] and
          Enum.all?(target_rows, &row_matches?(&1, expected_plugin, expected_third_party))

      cond do
        all_match ->
          IO.puts(IO.ANSI.format([:bright, :green, "✅ Target row(s) reached expected state.", :reset]))

        attempt >= max_attempts ->
          IO.puts(IO.ANSI.format([:bright, :red, "❌ Max polls (#{max_attempts}) reached without match.", :reset]))
          handle_timeout(provider_id, expected_plugin, expected_third_party, target, max_attempts)

        true ->
          case wait_or_stop(20_000) do
            :stop ->
              IO.puts(IO.ANSI.format([:yellow, "⏹  Polling stopped by user.", :reset]))

            :continue ->
              poll_acp(provider_id, expected_plugin, expected_third_party, target, attempt + 1, max_attempts)
          end
      end
    end
  end

  defp wait_or_stop(ms) do
    IO.puts(IO.ANSI.format([:faint, "Sleeping #{div(ms, 1000)}s... (type 'stop' + Enter to stop polling)", :reset]))

    parent = self()

    reader =
      spawn(fn ->
        case IO.gets("") do
          :eof -> send(parent, {:input, :eof})
          {:error, _} -> send(parent, {:input, :eof})
          line -> send(parent, {:input, line})
        end
      end)

    result =
      receive do
        {:input, :eof} ->
          :continue

        {:input, line} ->
          cleaned = line |> to_string() |> String.trim() |> String.downcase()
          if cleaned in ["s", "stop"], do: :stop, else: :continue
      after
        ms -> :continue
      end

    Process.exit(reader, :kill)
    result
  end

  defp handle_timeout(provider_id, expected_plugin, expected_third_party, target, max_attempts) do
    answer =
      case IO.gets("Timeout — (r)etry / (c)ontinue / (a)bort? ") do
        :eof -> "a"
        {:error, _} -> "a"
        line -> line |> String.trim() |> String.downcase()
      end

    case answer do
      "r" ->
        IO.puts(IO.ANSI.format([:faint, "Retrying poll...", :reset]))
        poll_acp(provider_id, expected_plugin, expected_third_party, target, 1, max_attempts)

      "c" ->
        IO.puts(IO.ANSI.format([:yellow, "⚠️  Continuing without expected state.", :reset]))

      "a" ->
        IO.puts(IO.ANSI.format([:bright, :red, "❌ Aborting.", :reset]))
        System.halt(1)

      _ ->
        IO.puts(IO.ANSI.format([:faint, "Unknown — treating as abort.", :reset]))
        System.halt(1)
    end
  end

  defp filter_target(rows, :all), do: rows

  defp filter_target(rows, :default) do
    Enum.filter(rows, fn r ->
      String.downcase(String.trim(Map.get(r, "is_default", ""))) in ["t", "true"]
    end)
  end

  defp filter_target(rows, {:crn, target_crn}) do
    Enum.filter(rows, fn r ->
      String.trim(Map.get(r, "crn", "")) == String.trim(target_crn)
    end)
  end

  defp row_matches?(r, expected_plugin, expected_third_party) do
    String.downcase(Map.get(r, "plugin_status", "")) == String.downcase(expected_plugin) and
      String.downcase(Map.get(r, "third_party_integration_status", "")) == String.downcase(expected_third_party)
  end

  defp print_row(r, expected_plugin, expected_third_party) do
    mark = if row_matches?(r, expected_plugin, expected_third_party), do: @check, else: "⏳"
    default_marker = if String.downcase(String.trim(Map.get(r, "is_default", ""))) in ["t", "true"], do: " [DEFAULT]", else: ""

    IO.puts(
      "  #{mark} provider_id=#{Map.get(r, "provider_id", "?")} crn=#{Map.get(r, "crn", "")}#{default_marker} #{Map.get(r, "loc_acp_id", "?")} plugin=#{Map.get(r, "plugin_status", "")} third_party=#{Map.get(r, "third_party_integration_status", "")}"
    )
  end

  defp run_or_paste(label, sql) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== #{label}: SQL ===", :reset]))
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))
    IO.puts("")

    cmd_args = ["psql", "production", "shedul", "--", "-c", sql, "--csv"]
    cmd_str = "houston " <> Enum.map_join(cmd_args, " ", &shell_quote/1)
    IO.puts(IO.ANSI.format([:faint, "Will run: #{cmd_str}", :reset]))

    answer =
      case IO.gets("Run via houston psql? (y = run, anything else = paste): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if answer in ["y", "yes"] do
      IO.puts(IO.ANSI.format([:faint, "Running...", :reset]))
      {out, code} = System.cmd("houston", cmd_args, stderr_to_stdout: true)
      IO.puts(IO.ANSI.format([:faint, "houston exit=#{code}", :reset]))

      if code != 0 do
        IO.puts(IO.ANSI.format([:red, out, :reset]))
        IO.puts(IO.ANSI.format([:bright, :red, "❌ houston failed. Falling back to paste.", :reset]))
        text = read_until_end("Paste #{label} output (psql tabular). Type END:")
        parse_psql(text)
      else
        IO.puts(IO.ANSI.format([:faint, "--- raw output ---", :reset]))
        IO.puts(out)
        IO.puts(IO.ANSI.format([:faint, "--- end raw output ---", :reset]))
        rows = parse_csv(out)
        IO.puts(IO.ANSI.format([:faint, "Parsed #{length(rows)} row(s) from CSV.", :reset]))
        rows
      end
    else
      text = read_until_end("Paste #{label} output (psql tabular). Type END:")
      parse_psql(text)
    end
  end

  defp parse_csv(text) do
    csv_text =
      text
      |> String.split("\n")
      |> Enum.drop_while(fn line ->
        t = String.trim(line)

        t == "" or
          Regex.match?(~r/^\d{4}\//, t) or
          String.starts_with?(t, "correlation_id") or
          Regex.match?(~r/^\s*correlation_id/, line)
      end)
      |> Enum.join("\n")

    case csv_text |> String.trim() do
      "" ->
        []

      cleaned ->
        rows = NimbleCSV.RFC4180.parse_string(cleaned, skip_headers: false)

        case rows do
          [] ->
            []

          [headers | data] ->
            Enum.map(data, fn vals ->
              headers |> Enum.zip(vals) |> Map.new()
            end)
        end
    end
  end

  defp shell_quote(s) do
    if String.contains?(s, [" ", "'", "\"", ";", "(", ")", "*", "$", "`"]) do
      "'" <> String.replace(s, "'", "'\\''") <> "'"
    else
      s
    end
  end

  defp read_until_end(prompt) do
    IO.puts(prompt)

    Stream.repeatedly(fn -> IO.gets("") end)
    |> Stream.take_while(fn
      :eof -> false
      {:error, _} -> false
      line -> String.trim(line) != "END"
    end)
    |> Enum.join("")
  end

  defp parse_psql(text) do
    lines = String.split(text, "\n")
    {_, with_header} = Enum.split_while(lines, fn l -> not String.contains?(l, "|") end)

    case with_header do
      [header | rest] ->
        cols = header |> String.split("|") |> Enum.map(&String.trim/1)
        rest = Enum.drop_while(rest, fn l -> Regex.match?(~r/^[\s\-+]+$/, l) end)

        rest
        |> Enum.take_while(fn l ->
          t = String.trim(l)
          t != "" and not String.starts_with?(t, "(")
        end)
        |> Enum.map(fn row ->
          values = row |> String.split("|") |> Enum.map(&String.trim/1)
          cols |> Enum.zip(values) |> Map.new()
        end)

      _ ->
        []
    end
  end

  defp show_provider(rows) do
    IO.puts("\n--- Provider billing check ---")

    case rows do
      [] ->
        IO.puts("#{@cross} no provider_billing_informations row")

      [row | _] ->
        Enum.each(["tax_number", "company_registration_number"], fn field ->
          v = Map.get(row, field, "")
          mark = if filled?(v), do: @check, else: @cross
          IO.puts("#{mark} #{field}: #{v}")
        end)
    end
  end

  defp show_locations(rows) do
    IO.puts("\n--- Location billing checks ---")

    Enum.each(rows, fn row ->
      loc_id = Map.get(row, "location_id", "?")
      IO.puts("\nlocation_id=#{loc_id}")

      Enum.each(@loc_fields, fn f ->
        v = Map.get(row, f, "")
        mark = if filled?(v), do: @check, else: @cross
        IO.puts("  #{mark} #{f}: #{v}")
      end)
    end)
  end

  defp suggest_tasks(rows) do
    IO.puts("\n--- Suggested houston tasks (DRY_RUN=true) ---")

    Enum.each(rows, fn row ->
      cmd = """
      houston task run partners-app update_location_billing_details \\
        -p LOCATION_ID="#{Map.get(row, "location_id", "")}" \\
        -p NAME="#{Map.get(row, "name", "")}" \\
        -p CITY_NAME="#{Map.get(row, "city_name", "")}" \\
        -p STATE="#{Map.get(row, "state", "")}" \\
        -p DISTRICT="#{Map.get(row, "district", "")}" \\
        -p POSTAL_CODE="#{Map.get(row, "postal_code", "")}" \\
        -p STREET_ADDRESS="#{Map.get(row, "street_address", "")}" \\
        -p BUILDING_NUMBER="#{Map.get(row, "building_number", "")}" \\
        -p VAT_NUMBER="#{Map.get(row, "vat_number", "")}" \\
        -p COMPANY_REGISTRATION_NUMBER="#{Map.get(row, "company_registration_number", "")}" \\
        -p DRY_RUN="true"\
      """

      IO.puts("")
      IO.puts(IO.ANSI.format([:yellow, cmd, :reset]))
    end)

    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :red, "⚠️  Verify these values with Nina before running. Do not proceed without her sign-off.", :reset]))
  end

  defp filled?(nil), do: false
  defp filled?(""), do: false

  defp filled?(v) when is_binary(v) do
    t = String.trim(v)
    t != "" and String.downcase(t) != "null"
  end

  defp filled?(_), do: false
end

provider_id =
  case System.argv() do
    [id] ->
      id

    _ ->
      case IO.gets("provider_id> ") do
        :eof -> ""
        {:error, _} -> ""
        line -> String.trim(line)
      end
  end

if provider_id == "" do
  IO.puts(:stderr, "provider_id required")
  System.halt(1)
end

Onboard.run(provider_id)
