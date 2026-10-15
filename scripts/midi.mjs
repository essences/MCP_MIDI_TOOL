#!/usr/bin/env node
import { runCli } from '../dist/cli/main.js';
await runCli(process.argv.slice(2));
