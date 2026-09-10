"use strict";

// `ops orion` — the Orion e-invoicing scripts group.

const { gh, reservedWords } = require("../program");

function register(program) {
  const orion = program
    .command("orion")
    .summary("Orion e-invoicing operational scripts (browse, read, run, lint the catalogue)")
    .description("Browse, read and run the operational scripts in the Orion scripts repo, and keep its catalogue honest.\n\nThe repo is found through OPS_ORION_SCRIPTS, then `ops config get orion.scripts`, then a sibling checkout at ../orion/scripts.")
    .helpGroup("GROUPS")
    .enablePositionalOptions();
  gh(orion, {
    examples: [{ cmd: "ops orion script list" }, { cmd: "ops orion script view retry_invoices" }, { cmd: "ops orion doctor" }],
  });

  const script = orion
    .command("script")
    .summary("List, view, run and scaffold scripts")
    .description("Work with the scripts themselves: list the catalogue, read one script's page, run one, pick one interactively or scaffold a new one.")
    .helpGroup("SCRIPT COMMANDS")
    .enablePositionalOptions();
  gh(script, {
    examples: [{ cmd: "ops orion script list --env production" }, { cmd: "ops orion script run ri --dry-run 1" }],
  });

  const ctx = { get reserved() { return reservedWords(program); } };
  require("./list").register(script, ctx);
  require("./view").register(script, ctx);
  require("./run").register(script, ctx);
  for (const mod of ["./pick", "./new"]) {
    try {
      require(mod).register(script, ctx);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
  for (const mod of ["./doctor", "./docs"]) {
    try {
      require(mod).register(orion, ctx);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
}

module.exports = { register };
