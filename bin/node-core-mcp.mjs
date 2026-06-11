#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { server, start } from '../lib/server.mjs';
import { registerTools } from '../lib/tools.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const ROOT = resolve(repoIdx !== -1 ? argv[repoIdx + 1] : dirname(fileURLToPath(import.meta.url)) + '/../../..');

const line1 = `   ⬡  node-core-mcp  v${version}`;
const line2 = `   Node.js Core MCP Server`;
const w = Math.max(line1.length, line2.length) + 2;
const logo = [
  `  ╭${'─'.repeat(w)}╮`,
  `  │${line1.padEnd(w)}│`,
  `  │${line2.padEnd(w)}│`,
  `  ╰${'─'.repeat(w)}╯`,
].join('\n');

process.stderr.write(`\n${logo}\n\n  root: ${ROOT}\n\n`);
registerTools(server, ROOT);
start();
