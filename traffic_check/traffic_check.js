#!/usr/bin/env node

// traffic_check — daily commute traffic check → Slack
//
// Queries the Google Maps Routes API for live-traffic travel time on a fixed
// route, compares it to the free-flow baseline, and posts a one-line summary
// to a Slack channel via an incoming webhook. Designed to run unattended from
// cron (see README.md), but also works as a manual CLI run for testing.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
// Prefer an explicit path, then a config file next to the script (gitignored),
// then the shared location under ~/.config/orion.
const LOCAL_CONFIG = path.join(__dirname, "traffic_check.json");
const CONFIG_PATH =
  process.env.TRAFFIC_CONFIG_PATH ||
  (fs.existsSync(LOCAL_CONFIG)
    ? LOCAL_CONFIG
    : path.join(os.homedir(), ".config", "orion", "traffic_check.json"));

// ANSI colors for console output (matches repo convention of colored CLI output)
const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

// --- Config -----------------------------------------------------------------

function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse config at ${CONFIG_PATH}: ${err.message}`);
    }
  }

  // Env vars override the config file (handy for shell testing).
  const config = {
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || fileConfig.googleMapsApiKey,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || fileConfig.slackWebhookUrl,
    origin: process.env.TRAFFIC_ORIGIN || fileConfig.origin,
    destination: process.env.TRAFFIC_DESTINATION || fileConfig.destination,
    label: process.env.TRAFFIC_LABEL || fileConfig.label || "Commute",
  };

  const missing = ["googleMapsApiKey", "slackWebhookUrl", "origin", "destination"].filter(
    (key) => !config[key]
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(", ")}.\n` +
        `Set them in ${CONFIG_PATH} or via env vars ` +
        `(GOOGLE_MAPS_API_KEY, SLACK_WEBHOOK_URL, TRAFFIC_ORIGIN, TRAFFIC_DESTINATION).`
    );
  }
  return config;
}

// --- Google Routes API ------------------------------------------------------

// Build a Routes API waypoint from a config value. Accepts either a
// "lat, lng" coordinate string or a plain address.
function buildWaypoint(value) {
  const match = String(value)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    return {
      location: {
        latLng: { latitude: parseFloat(match[1]), longitude: parseFloat(match[2]) },
      },
    };
  }
  return { address: value };
}

async function fetchRoute(config) {
  const body = {
    origin: buildWaypoint(config.origin),
    destination: buildWaypoint(config.destination),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date().toISOString(),
  };

  const res = await fetch(ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googleMapsApiKey,
      "X-Goog-FieldMask":
        "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Routes API failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) {
    throw new Error(`No route returned for ${config.origin} → ${config.destination}`);
  }
  return route;
}

// Durations come back as protobuf strings like "1380s".
function parseSeconds(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(parseFloat(match[1])) : null;
}

// --- Formatting -------------------------------------------------------------

function classifyDelay(liveSec, baseSec) {
  // No baseline (some routes omit staticDuration) → report live time only.
  if (!baseSec) return { color: "dim", emoji: "🚗", level: "no baseline" };
  const ratio = (liveSec - baseSec) / baseSec;
  if (ratio < 0.1) return { color: "green", emoji: "🟢", level: "light" };
  if (ratio < 0.3) return { color: "yellow", emoji: "🟡", level: "moderate" };
  return { color: "red", emoji: "🔴", level: "heavy" };
}

function minutes(sec) {
  return Math.round(sec / 60);
}

function buildMessage(config, route) {
  const liveSec = parseSeconds(route.duration);
  const baseSec = parseSeconds(route.staticDuration);
  if (liveSec == null) {
    throw new Error(`Could not parse duration from route: ${JSON.stringify(route)}`);
  }

  const km = route.distanceMeters ? (route.distanceMeters / 1000).toFixed(1) : null;
  const { color, emoji, level } = classifyDelay(liveSec, baseSec);

  let text = `${emoji} ${config.label} — ${minutes(liveSec)} min now`;
  if (baseSec) {
    const delay = minutes(liveSec) - minutes(baseSec);
    const sign = delay >= 0 ? "+" : "";
    text += ` vs ${minutes(baseSec)} min normal (${sign}${delay} min, ${level})`;
  }
  if (km) text += `. ${km} km`;
  text += ".";

  return { text, color };
}

// --- Slack ------------------------------------------------------------------

async function postToSlack(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const responseText = await res.text();
    throw new Error(`Slack webhook failed (${res.status}): ${responseText}`);
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const route = await fetchRoute(config);
  const { text, color } = buildMessage(config, route);

  // Print to stdout (cron logs / manual runs), then deliver to Slack.
  console.log(`${COLORS[color] || ""}${text}${COLORS.reset}`);
  await postToSlack(config.slackWebhookUrl, text);
  console.log(`${COLORS.dim}Posted to Slack.${COLORS.reset}`);
}

main().catch((err) => {
  console.error(`${COLORS.red}Error: ${err.message}${COLORS.reset}`);
  process.exit(1);
});

// node traffic_check.js
