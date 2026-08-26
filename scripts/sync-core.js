#!/usr/bin/env node
/**
 * Copy the core codecs into the web app so the browser can import them with a
 * plain relative path. Keeps the project build-free: no bundler, no config.
 *
 *   node scripts/sync-core.js            # for local development
 *   node scripts/sync-core.js dist       # assemble a deployable folder
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'apps/web');

if (process.argv[2]) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(root, 'apps/web'), target, { recursive: true });
  cpSync(join(root, 'docs'), join(target, 'docs'), { recursive: true });
}

const vendor = join(target, 'vendor/core');
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
cpSync(join(root, 'packages/core/src'), vendor, { recursive: true });

console.log(`core copied to ${vendor.replace(root, '.')}`);
