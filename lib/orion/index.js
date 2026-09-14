"use strict";

// `ops orion` — the Orion e-invoicing scripts group.

const { gh } = require("../program");

function register(program) {
  const orion = program
    .command("orion")
    .summary("The Orion scripts catalogue: browse, read, lint, scaffold")
    .description("Browse and read the operational scripts in orion/ (this repo), and keep their catalogue honest. Running one is `ops run <script>`.\n\nThe scripts directory is found through OPS_ORION_SCRIPTS, then `ops config get orion.scripts`, then orion/ inside the ops repo.")
    .helpGroup("GROUPS")
    .enablePositionalOptions();
  gh(orion, {
    examples: [{ cmd: "ops orion script list" }, { cmd: "ops orion script view resend_stuck_invoices" }, { cmd: "ops orion docs check" }],
  });

  const script = orion
    .command("script")
    .summary("List, view, pick and scaffold scripts")
    .description("Work with the catalogue: list the scripts, read one's page, pick one interactively or scaffold a new one. To run one, use `ops run <script>`.")
    .helpGroup("SCRIPT COMMANDS")
    .enablePositionalOptions();
  gh(script, {
    examples: [{ cmd: "ops orion script list --env production" }, { cmd: "ops orion script view ri" }],
  });

  // `ops run`, `ops task` and `ops interactive` sit at the root: running a script
  // is what this tool is for, and it should not be three words deep.
  require("./task").register(program);
  require("./interactive").register(program);
  require("./list").register(script);
  require("./view").register(script);

  for (const mod of ["./pick", "./new"]) {
    try {
      require(mod).register(script);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
  for (const mod of ["./doctor", "./docs"]) {
    try {
      require(mod).register(orion);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
}

module.exports = { register };
