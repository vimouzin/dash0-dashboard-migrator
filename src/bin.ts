#!/usr/bin/env node
// Entry point for the standalone executable (bun build --compile) and the npm bin. cli.ts only auto-runs when it is
// the script itself, which a compiled binary never is.
import { main } from "./cli.js";

void Promise.resolve(main()).then((code) => {
  process.exitCode = code;
});
