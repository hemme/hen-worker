#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ARGS = new Set(process.argv.slice(2));
const AUTO_YES = ARGS.has('--yes') || ARGS.has('-y');
const SKIP_CONFIG = ARGS.has('--no-config');
const DRY_RUN = ARGS.has('--dry-run');
const IS_TTY = process.stdin.isTTY;

const KEYS = [
  { key: 'config:limit', defaultKey: 'DEFAULT_RATE_LIMIT' },
  { key: 'config:window_minutes', defaultKey: 'DEFAULT_RATE_LIMIT_WINDOW_MINUTES' },
];

const C = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function getDefaults() {
  const src = readFileSync(join(ROOT, 'index.js'), 'utf8');
  const out = {};
  for (const [name, key] of [
    ['DEFAULT_RATE_LIMIT', 'limit'],
    ['DEFAULT_RATE_LIMIT_WINDOW_MINUTES', 'window'],
  ]) {
    const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    if (!m) throw new Error(`Unable to find ${name} in index.js`);
    out[key] = m[1];
  }
  return out;
}

function getNamespaceId() {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  const m = toml.match(/id\s*=\s*"([0-9a-fA-F]+)"/);
  if (!m) throw new Error('Unable to find KV namespace id in wrangler.toml');
  return m[1];
}

async function askYesNo(question) {
  if (!IS_TTY) return false;
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === '' || ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function syncConfig(namespaceId, defaults) {
  for (const { key, defaultKey } of KEYS) {
    const target = defaultKey === 'DEFAULT_RATE_LIMIT' ? defaults.limit : defaults.window;

    let current = null;
    if (!DRY_RUN) {
      const res = run('wrangler', ['kv', 'key', 'get', `--namespace-id=${namespaceId}`, '--remote', key]);
      current = res.code === 0 ? res.stdout : null;
    }

    if (current === target) {
      console.log(C.green(`  ${key} = ${target} (already up to date)`));
      continue;
    }

    const currentLabel = current === null ? C.yellow('(missing)') : current;
    console.log(`  ${key}: ${currentLabel} -> ${C.cyan(target)}`);

    if (DRY_RUN) {
      console.log(C.dim(`  [dry-run] skipping write for ${key}`));
      continue;
    }

    if (SKIP_CONFIG) {
      console.log(C.dim(`  [--no-config] leaving ${key} untouched`));
      continue;
    }

    if (AUTO_YES) {
      console.log(C.green(`  [--yes] writing ${key} = ${target}`));
    } else if (IS_TTY) {
      const ok = await askYesNo(`  Update ${key} to ${target}? [Y/n] `);
      if (!ok) {
        console.log(C.dim(`  Skipped ${key}`));
        continue;
      }
    } else {
      console.log(C.yellow(`  [non-interactive] leaving ${key} untouched (use --yes to auto-apply)`));
      continue;
    }

    const put = run('wrangler', ['kv', 'key', 'put', `--namespace-id=${namespaceId}`, '--remote', key, target]);
    if (put.code !== 0) {
      console.error(C.red(`  Failed to write ${key}: ${put.stderr || put.stdout}`));
      process.exit(1);
    }
    console.log(C.green(`  Updated ${key} = ${target}`));
  }
}

async function main() {
  let namespaceId;
  try {
    namespaceId = getNamespaceId();
  } catch (e) {
    console.error(C.red(`Error: ${e.message}`));
    process.exit(1);
  }

  let defaults;
  try {
    defaults = getDefaults();
  } catch (e) {
    console.error(C.red(`Error: ${e.message}`));
    process.exit(1);
  }

  if (SKIP_CONFIG) {
    console.log(C.dim('[--no-config] skipping rate limit config sync'));
  } else {
    console.log(C.cyan('Checking rate limit config in KV...'));
    await syncConfig(namespaceId, defaults);
  }

  console.log(C.cyan(DRY_RUN ? 'Running dry-run build...' : 'Deploying worker to Cloudflare...'));
  const deployArgs = DRY_RUN ? ['deploy', '--dry-run'] : ['deploy'];
  const deploy = spawnSync('wrangler', deployArgs, { stdio: 'inherit' });
  if (deploy.status !== 0) {
    console.error(C.red('Deploy failed.'));
    process.exit(deploy.status ?? 1);
  }

  console.log(C.green('Done!'));
}

main();
