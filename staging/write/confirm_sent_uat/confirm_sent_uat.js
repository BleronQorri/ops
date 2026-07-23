#!/usr/bin/env node

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const BASE_URL = "https://edi-uat.edoc-online.com/EdiRest";
const CONFIG_TYPE = 1;
const CONFIG_IDS = {
  invoice: 119208,
  onboarding: 119286,
};

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function promptQueueType(rl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await rl.question("Queue type? (invoice/onboarding): "))
      .trim()
      .toLowerCase();
    if (answer === "invoice" || answer === "i") return "invoice";
    if (answer === "onboarding" || answer === "o") return "onboarding";
    console.error(`Invalid input: "${answer}". Expected invoice/i or onboarding/o.`);
  }
  throw new Error("Too many invalid attempts.");
}

async function promptToken(rl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = (await rl.question("Comarch JWT token: ")).trim();
    if (value) return value;
    console.error("Token cannot be empty.");
  }
  throw new Error("No token provided.");
}

async function fetchSent(headers, configId) {
  const url = `${BASE_URL}/api/status/sent`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ConfigType: CONFIG_TYPE, ConfigId: configId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/status/sent failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function confirmSent(headers, records) {
  const statusesToConfirm = records.map((r) => ({
    WebStatusId: r.WebStatusId,
    ConfigType: r.ConfigType,
    ConfigId: r.ConfigId,
  }));

  const url = `${BASE_URL}/api/status/sent/confirm`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ StatusesToConfirm: statusesToConfirm }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/status/sent/confirm failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function promptContinue(rl) {
  const answer = (await rl.question("Try clearing more? (y/n): "))
    .trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const queueType = await promptQueueType(rl);
    const token = await promptToken(rl);
    const configId = CONFIG_IDS[queueType];
    const headers = buildHeaders(token);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Using ${queueType} queue (ConfigId=${configId})`);

    while (true) {
      console.log("Fetching sent records...");
      const records = await fetchSent(headers, configId);
      console.log(`Fetched ${records.length} record(s)`);

      if (records.length === 0) {
        console.log("Queue empty. Done.");
        return;
      }

      console.log("Confirming all records...");
      const result = await confirmSent(headers, records);
      console.log("Confirm response:", JSON.stringify(result, null, 2));

      const again = await promptContinue(rl);
      if (!again) {
        console.log("Stopping.");
        return;
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

// node confirm_sent_uat.js
