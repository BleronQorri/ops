#!/usr/bin/env elixir

defmodule Onboard do
  @loc_fields ~w(name city_name state district postal_code street_address building_number vat_number company_registration_number)
  @check "✅"
  @cross "❌"

  def run(provider_id) do
    IO.puts("""
    -- Purpose: provider onboarding check (db: shedul).
    -- Step 1: run Q1, paste output → check tax_number + company_registration_number.
    -- Step 2: run Q2, paste output → per-location field checks + houston task suggestions.
    """)

    print_q1(provider_id)
    pbi_text = read_until_end("Paste Q1 output. Type END on its own line when done:")
    pbi_rows = parse_psql(pbi_text)
    show_provider(pbi_rows)

    print_q2(provider_id)
    loc_text = read_until_end("Paste Q2 output. Type END on its own line when done:")
    loc_rows = parse_psql(loc_text)

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

      gate_provider_onboarded(provider_id, company_name, employee_id, pbi_rows, loc_rows)
    end
  end

  defp gate_provider_onboarded(provider_id, company_name, employee_id, pbi_rows, loc_rows) do
    answer =
      case IO.gets("\nProvider onboarding successful? (y/N): ") do
        :eof -> ""
        {:error, _} -> ""
        line -> line |> String.trim() |> String.downcase()
      end

    if answer in ["y", "yes"] do
      IO.puts(IO.ANSI.format([:bright, :green, "✅ Provider onboarded. Proceeding to onboard non-default locations.", :reset]))
      stage_onboard_locations(provider_id, company_name, pbi_rows, loc_rows)
      _ = employee_id
    else
      IO.puts(IO.ANSI.format([:bright, :red, "❌ Provider onboarding not successful. Investigate, then re-run.", :reset]))
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

  defp print_q1(pid) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Q1: provider_billing_informations ===", :reset]))
    sql = "SELECT provider_id, tax_number, company_registration_number FROM provider_billing_informations WHERE provider_id = '#{pid}' AND valid_to IS NULL;"
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))
    IO.puts("")
  end

  defp print_q2(pid) do
    IO.puts("")
    IO.puts(IO.ANSI.format([:bright, :white, "=== Q2: location_billing_details ===", :reset]))
    sql = "SELECT location_id, name, city_name, state, district, postal_code, street_address, building_number, vat_number, company_registration_number FROM location_billing_details WHERE location_id IN (SELECT id FROM locations WHERE provider_id = '#{pid}');"
    IO.puts(IO.ANSI.format([:cyan, sql, :reset]))
    IO.puts("")
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
