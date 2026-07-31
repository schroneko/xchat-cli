#!/usr/bin/env node

import { runCli } from "../src/cli.js";
import { redactError } from "../src/redaction.js";

runCli(process.argv.slice(2)).catch((error) => {
  const exitCode = error.exitCode ?? 1;
  const payload = {
    ok: false,
    error: redactError(error),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
});
