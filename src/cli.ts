#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { collectUsage, lockName } from './collect.ts';
import { withFileLock } from './lock.ts';
import { providers as defaultProviders } from './providers/index.ts';
import { colorMode, renderJson, renderOverview, type ColorMode } from './render.ts';
import { listAccounts, removeAccount, upsertAccount } from './store/accounts.ts';
import { deleteCredentials, loadCredentials, saveCredentials } from './store/credentials.ts';
import { accountId, type Account, type LoginIO, type Provider, type ProviderId } from './types.ts';

// Only providers that are implemented.
const SUPPORTED_PROVIDERS = Object.keys(defaultProviders).join('|');
// Short names ("personal") or e-mail addresses ("ja@pvachek.cz"); must stay Keychain-safe (see store/keychain.ts).
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_.@+-]{0,63}$/;
const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 30_000;

const USAGE = `Usage:
  aiu                                        show usage of all accounts
  aiu --json                                 same, as JSON
  aiu login <${SUPPORTED_PROVIDERS}> [--name <label>]
                                             add or re-login an account; the label
                                             defaults to the login e-mail (not for grok)
  aiu accounts                               list configured accounts
  aiu remove <provider>/<label>              remove an account and its stored login`;

export interface CliDeps {
  providers: Partial<Record<ProviderId, Provider<unknown>>>;
  listAccounts: () => Promise<Account[]>;
  upsertAccount: (account: Account) => Promise<void>;
  removeAccount: (id: string) => Promise<boolean>;
  loadCredentials: (id: string) => Promise<unknown | null>;
  saveCredentials: (id: string, credentials: unknown) => Promise<void>;
  deleteCredentials: (id: string) => Promise<void>;
  io: LoginIO;
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
  color: ColorMode;
  lock: typeof withFileLock;
}

const terminalIO: LoginIO = {
  print: (message) => process.stderr.write(`${message}\n`),
  prompt: async (question, options) => {
    if (!options?.secret) {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await readline.question(question);
      } finally {
        readline.close();
      }
    }
    // Secret answers (e.g. a session cookie) must not stay in the terminal scrollback: readline echoes
    // into a stream that drops everything, and only the question goes to the terminal.
    process.stderr.write(question);
    const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
    const readline = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
    try {
      return await readline.question('');
    } finally {
      readline.close();
      process.stderr.write('\n');
    }
  },
  openUrl: (url) =>
    new Promise((resolve) => {
      // Opening the browser is best effort; the URL is also printed.
      execFile('open', [url], () => resolve());
    }),
};

const defaultDeps = (): CliDeps => ({
  providers: defaultProviders,
  listAccounts,
  upsertAccount,
  removeAccount,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  io: terminalIO,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  now: () => new Date(),
  color: colorMode(process.stdout, process.env),
  lock: withFileLock,
});

async function showUsage(deps: CliDeps, json: boolean): Promise<number> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0 && json) {
    deps.out(renderJson([], deps.now()));
    return 0;
  }
  if (accounts.length === 0) {
    deps.out(`No accounts yet. Add one with: aiu login <${SUPPORTED_PROVIDERS}> [--name <label>]`);
    return 0;
  }
  const usages = await collectUsage(accounts, {
    providers: deps.providers,
    loadCredentials: deps.loadCredentials,
    saveCredentials: deps.saveCredentials,
    now: deps.now,
    timeoutMs: FETCH_TIMEOUT_MS,
    refreshTimeoutMs: REFRESH_TIMEOUT_MS,
    lock: deps.lock,
  });
  const now = deps.now();
  if (json) {
    deps.out(renderJson(usages, now));
    return 0;
  }
  deps.out(renderOverview(usages, now, { color: deps.color }));
  return 0;
}

/**
 * The label for a login without --name: the known account with the same e-mail (a re-login),
 * otherwise the e-mail itself, lowercased like every label.
 */
function labelFromIdentity(
  providerId: ProviderId,
  identity: string | undefined,
  accounts: Account[],
): { label: string } | { error: string } {
  if (!identity) return { error: `${providerId} did not report the account e-mail` };
  const email = identity.toLowerCase();
  const known = accounts.filter(
    (account) => account.provider === providerId && account.identity?.toLowerCase() === email,
  );
  if (known.length > 1) {
    return { error: `Several ${providerId} accounts use ${identity} (${known.map((account) => account.label).join(', ')})` };
  }
  if (known[0]) return { label: known[0].label };
  if (!LABEL_PATTERN.test(email)) return { error: `The e-mail ${identity} cannot be used as a label` };
  return { label: email };
}

async function login(deps: CliDeps, providerName: string | undefined, name: string | undefined): Promise<number> {
  const supported = Object.keys(deps.providers);
  const provider = providerName && supported.includes(providerName) ? deps.providers[providerName as ProviderId] : undefined;
  if (!provider) {
    deps.err(`Unknown provider: ${providerName ?? '(none)'}. Use one of: ${supported.join(', ')}`);
    return 2;
  }
  if (name !== undefined && !LABEL_PATTERN.test(name)) {
    deps.err(
      'Invalid label: use up to 64 lowercase letters, digits or "-_.@+" (e.g. "personal" or an e-mail), starting with a letter or digit.',
    );
    return 2;
  }
  // Fail before the login prompts when the label could not be derived afterwards.
  if (name === undefined && !provider.reportsIdentity) {
    deps.err(`${provider.id} does not report the account e-mail; pass --name <label>.`);
    return 2;
  }
  const result = await provider.login(deps.io);
  const accounts = await deps.listAccounts();
  const derived = name === undefined ? labelFromIdentity(provider.id, result.identity, accounts) : { label: name };
  if ('error' in derived) {
    deps.err(`${derived.error}; pass --name <label>.`);
    return 2;
  }
  const account: Account = { provider: provider.id, label: derived.label };
  const id = accountId(account);
  const isNew = !accounts.some((existing) => accountId(existing) === id);
  await deps.lock(lockName(id), () => deps.saveCredentials(id, result.credentials));
  try {
    await deps.upsertAccount(result.identity ? { ...account, identity: result.identity } : account);
  } catch (error) {
    // Do not leave a secret behind that no account entry points to.
    if (isNew) await deps.deleteCredentials(id).catch(() => undefined);
    throw error;
  }
  deps.out(`${isNew ? 'Added' : 'Logged in again to'} ${id}${result.identity ? ` (${result.identity})` : ''}`);
  return 0;
}

async function listCommand(deps: CliDeps): Promise<number> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) deps.out('No accounts yet.');
  accounts.forEach((account) => deps.out(`${accountId(account)}  ${account.identity ?? ''}`.trimEnd()));
  return 0;
}

async function removeCommand(deps: CliDeps, id: string | undefined): Promise<number> {
  if (!id) {
    deps.err(USAGE);
    return 2;
  }
  const accounts = await deps.listAccounts();
  if (!accounts.some((account) => accountId(account) === id)) {
    deps.err(`No such account: ${id}`);
    return 1;
  }
  // Credentials first: if the Keychain refuses, the account stays listed and `remove` can be retried.
  // Under the account lock, so an in-flight token refresh cannot write the secret back.
  await deps.lock(lockName(id), () => deps.deleteCredentials(id));
  await deps.removeAccount(id);
  deps.out(`Removed ${id}`);
  return 0;
}

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    deps.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }

  const [command, argument, ...extra] = positionals;
  if (extra.length > 0) {
    deps.err(`Unexpected argument: ${extra.join(' ')}\n\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case undefined:
        return await showUsage(deps, values.json ?? false);
      case 'login':
        return await login(deps, argument, values.name);
      case 'accounts':
        return await listCommand(deps);
      case 'remove':
        return await removeCommand(deps, argument);
      default:
        deps.err(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    deps.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
