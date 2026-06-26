#!/usr/bin/env node
/**
 * Passes Node runtime validation probes but prints OpenCode help when launched
 * as a supervisor (i.e. with supervisorMain in argv).
 */
const args = process.argv.slice(2);
if (args[0] === "-p" && args[1] === "process.versions.node") {
  process.stdout.write(`${process.version.slice(1)}\n`);
  process.exit(0);
}
if (args.some((token) => token.includes("supervisorMain"))) {
  process.stdout.write("opencode - OpenCode CLI\n");
  process.stdout.write("Usage: opencode <command>\n");
  process.stdout.write("Commands: run, agent, session, serve, ...\n");
  process.exit(0);
}
process.stderr.write("fakeNodeValidationOnly: unexpected invocation\n");
process.exit(1);
