#!/usr/bin/env node
import { runCli } from '../lib/cli/main.js';
await runCli(process.argv.slice(2));
