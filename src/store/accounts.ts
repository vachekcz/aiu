import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountId, type Account } from '../types.ts';
import { writeJsonFile } from './jsonFile.ts';

export const configDir = (): string =>
  process.env.AI_USAGE_CONFIG_DIR || join(homedir(), '.config', 'ai-usage');

const accountsFile = (): string => join(configDir(), 'accounts.json');

export async function listAccounts(): Promise<Account[]> {
  try {
    return JSON.parse(await readFile(accountsFile(), 'utf8')) as Account[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const saveAccounts = (accounts: Account[]): Promise<void> => writeJsonFile(accountsFile(), accounts);

export async function upsertAccount(account: Account): Promise<void> {
  const accounts = await listAccounts();
  const id = accountId(account);
  const exists = accounts.some((existing) => accountId(existing) === id);
  const updated = exists
    ? accounts.map((existing) => (accountId(existing) === id ? account : existing))
    : [...accounts, account];
  await saveAccounts(updated);
}

export async function removeAccount(id: string): Promise<boolean> {
  const accounts = await listAccounts();
  const remaining = accounts.filter((account) => accountId(account) !== id);
  if (remaining.length === accounts.length) return false;
  await saveAccounts(remaining);
  return true;
}
