#!/usr/bin/env node
/**
 * Fake OpenCode CLI that always prints top-level help (no model/provider calls).
 */
process.stdout.write("opencode - OpenCode CLI\n");
process.stdout.write("Usage: opencode <command>\n");
process.stdout.write("Commands: run, agent, session, serve, ...\n");
process.exit(0);
