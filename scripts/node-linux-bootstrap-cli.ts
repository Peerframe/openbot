#!/usr/bin/env node

import { runPrivilegedLinuxBootstrapCli } from "./node-linux-bootstrap-command.ts";

process.exitCode = await runPrivilegedLinuxBootstrapCli({
  arguments: process.argv.slice(2),
  environment: { GH_TOKEN: Reflect.get(process.env, "GH_TOKEN") },
  runtime: { architecture: process.arch, platform: process.platform },
  writeError: (value) => process.stderr.write(value),
  writeOutput: (value) => process.stdout.write(value),
});
