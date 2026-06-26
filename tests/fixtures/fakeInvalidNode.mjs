#!/usr/bin/env node
/**
 * Fake executable that is not a valid Node runtime for supervisor validation.
 */
process.stderr.write("not a node runtime\n");
process.exit(1);
