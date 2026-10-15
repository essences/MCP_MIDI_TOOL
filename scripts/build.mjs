#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// dist contains generated build output only. Never touch data or skill archives.
await fs.rm(new URL('../dist/', import.meta.url), {recursive: true, force: true});
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json'], {cwd: root, stdio: 'inherit'});
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('exit', (code, signal) => {process.exitCode = code ?? (signal ? 1 : 0);});
