#!/usr/bin/env node
/**
 * Regenerate packages/core/src/tokens-8x.js from the TI-Toolkit token sheet.
 *
 *   node scripts/build-tokens.js path/to/8X.json
 *   node scripts/build-tokens.js --fetch
 *
 * The sheet lives at https://github.com/TI-Toolkit/tokens (branch `built`) and
 * is CC0. Only the English `accessible` names are used: they are pure ASCII,
 * and — unlike the `display` names — no two tokens share one, which is what
 * makes text -> token conversion decidable at all. See docs/8XP-FORMAT.md §4.
 *
 * The generated table is committed. This script exists so the next person can
 * see where the numbers came from and refresh them, not as a build step.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SHEET_URL = 'https://raw.githubusercontent.com/TI-Toolkit/tokens/built/8X.json';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'packages/core/src/tokens-8x.js');

/** Model names as they appear in the sheet, oldest first. */
const MODELS = ['TI-82', 'TI-83', 'TI-82A', 'TI-83+', 'TI-84+', 'TI-84+T', 'TI-83PCE', 'TI-84+CSE', 'TI-84+CE'];

const arg = process.argv[2];
if (!arg) {
  console.error('usage: build-tokens.js <8X.json> | --fetch');
  process.exit(1);
}

const sheet = JSON.parse(
  arg === '--fetch' ? await (await fetch(SHEET_URL)).text() : readFileSync(resolve(arg), 'utf8'),
);

/**
 * Flatten `{"$BB": {"$6D": [...versions]}}` into hex -> newest English entry.
 * Later entries in a token's array supersede earlier ones; the last one with
 * an `en` block is what a current calculator shows.
 */
const tokens = new Map();
const hex = (key) => key.slice(1);
const newest = (versions) => {
  for (let i = versions.length - 1; i >= 0; i--) if (versions[i].langs?.en) return versions[i];
  return null;
};

for (const [key, value] of Object.entries(sheet)) {
  if (Array.isArray(value)) {
    const entry = newest(value);
    if (entry) tokens.set(hex(key), entry);
  } else {
    for (const [low, versions] of Object.entries(value)) {
      const entry = newest(versions);
      if (entry) tokens.set(hex(key) + hex(low), entry);
    }
  }
}

const rows = [...tokens]
  .sort(([a], [b]) => (a.length - b.length) || a.localeCompare(b))
  .map(([code, entry]) => {
    const name = entry.langs.en.accessible ?? entry.langs.en.display;
    const model = entry.since?.model ?? 'TI-82';
    const tier = MODELS.indexOf(model);
    if (tier < 0) throw new Error(`unknown model "${model}" for token ${code}`);
    // One JSON string per token: names contain backslashes, backticks, `$` and
    // even a newline, so let JSON.stringify do the escaping rather than us.
    return JSON.stringify(`${code}\t${tier}\t${name}`);
  });

const duplicates = new Map();
for (const [code, entry] of tokens) {
  const name = entry.langs.en.accessible ?? entry.langs.en.display;
  if (duplicates.has(name)) {
    throw new Error(`accessible name ${JSON.stringify(name)} is shared by ${duplicates.get(name)} and ${code}`);
  }
  duplicates.set(name, code);
}

const file = `/**
 * The TI-83/84 token table: byte sequence <-> the name TI's own software shows.
 *
 * GENERATED — do not edit. Run \`node scripts/build-tokens.js --fetch\` instead.
 * Source: TI-Toolkit/tokens (CC0), English \`accessible\` spellings.
 *
 * One entry per token, tab separated: hex code, earliest model that has it,
 * and the name. One token per line keeps the diffs readable.
 */

/** Models in release order; a token's tier indexes into this. */
export const MODELS = ${JSON.stringify(MODELS)};

/** Second bytes only follow these first bytes. Everything else is one byte. */
export const TWO_BYTE_PREFIXES = ${JSON.stringify([...new Set([...tokens.keys()].filter((k) => k.length === 4).map((k) => k.slice(0, 2)))].sort())};

const TABLE = [
${rows.join(',\n')},
];

/** @type {Map<string, {name: string, tier: number}>} hex code -> token */
export const BY_CODE = new Map();
/** @type {Map<string, string>} name -> hex code */
export const BY_NAME = new Map();
/** Longest token name, in characters — the greedy matcher's look-ahead. */
export let LONGEST_NAME = 0;

for (const row of TABLE) {
  const tab = row.indexOf('\\t');
  const code = row.slice(0, tab);
  const tier = Number(row.slice(tab + 1, tab + 2));
  const name = row.slice(tab + 3);
  BY_CODE.set(code, { name, tier });
  BY_NAME.set(name, code);
  if (name.length > LONGEST_NAME) LONGEST_NAME = name.length;
}
`;

writeFileSync(TARGET, file);
console.log(`wrote ${TARGET}`);
const codes = [...tokens.keys()];
console.log(
  `  ${codes.length} tokens ` +
    `(${codes.filter((c) => c.length === 2).length} one-byte, ${codes.filter((c) => c.length === 4).length} two-byte)`,
);
