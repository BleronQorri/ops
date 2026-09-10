"use strict";

// ~/.config/ops/config.json
//   { "orion": { "scripts": "/abs/path" } }

const fs = require("fs");
const os = require("os");
const path = require("path");
const { UsageError } = require("./ui");

const CONFIG_DIR = process.env.OPS_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ops");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new UsageError(`could not read ${CONFIG_FILE}: ${e.message}`);
  }
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

// Dotted keys: "orion.scripts"
function get(key) {
  let cur = load();
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function set(key, value) {
  const cfg = load();
  const parts = key.split(".");
  let cur = cfg;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  save(cfg);
}

function unset(key) {
  const cfg = load();
  const parts = key.split(".");
  let cur = cfg;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== "object") return false;
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) return false;
  delete cur[last];
  save(cfg);
  return true;
}

// Flatten to [["orion.scripts", "/x"], ...] for `ops config list`.
function entries(obj = load(), prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...entries(v, key));
    else out.push([key, v]);
  }
  return out;
}

module.exports = { CONFIG_FILE, load, save, get, set, unset, entries };
