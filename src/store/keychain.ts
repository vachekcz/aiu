import { spawn } from 'node:child_process';

/**
 * Secrets live in the macOS login Keychain, written through `security -i` with
 * commands on stdin so they never show up in argv (visible via `ps`).
 * `security -i` truncates input lines around 4 KB, so values are base64-encoded
 * and split into chunks stored as `<account>#<index>`; the head item `<account>`
 * holds `chunks:<count>`.
 */

const CHUNK_SIZE = 3000;
const NOT_FOUND_EXIT_CODE = 44;
// Characters that need no quoting inside `security -i` double-quoted arguments.
const SAFE_ACCOUNT = /^[A-Za-z0-9_./@+-]+$/;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const service = (): string => process.env.AI_USAGE_KEYCHAIN_SERVICE ?? 'ai-usage';

function runSecurity(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function assertSafeAccount(account: string): void {
  if (!SAFE_ACCOUNT.test(account)) throw new Error(`Invalid keychain account name: ${account}`);
}

const chunkItem = (account: string, index: number): string => `${account}#${index}`;

async function readItem(item: string): Promise<string | null> {
  const result = await runSecurity(['find-generic-password', '-s', service(), '-a', item, '-w']);
  if (result.code === NOT_FOUND_EXIT_CODE) return null;
  if (result.code !== 0) throw new Error(`Keychain read failed (${result.code}): ${result.stderr.trim()}`);
  return result.stdout.replace(/\n$/, '');
}

async function deleteItem(item: string): Promise<boolean> {
  const result = await runSecurity(['delete-generic-password', '-s', service(), '-a', item]);
  if (result.code === NOT_FOUND_EXIT_CODE) return false;
  if (result.code !== 0) throw new Error(`Keychain delete failed (${result.code}): ${result.stderr.trim()}`);
  return true;
}

async function deleteChunksFrom(account: string, firstIndex: number): Promise<void> {
  for (let index = firstIndex; await deleteItem(chunkItem(account, index)); index++) {
    // keep deleting until the first missing chunk
  }
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
    chunks.push(text.slice(offset, offset + CHUNK_SIZE));
  }
  return chunks.length > 0 ? chunks : [''];
}

export async function writeSecret(account: string, value: string): Promise<void> {
  assertSafeAccount(account);
  const chunks = splitIntoChunks(Buffer.from(value, 'utf8').toString('base64'));
  const addCommand = (item: string, secret: string) =>
    `add-generic-password -U -s "${service()}" -a "${item}" -w "${secret}"\n`;
  const commands = [
    ...chunks.map((chunk, index) => addCommand(chunkItem(account, index), chunk)),
    addCommand(account, `chunks:${chunks.length}`),
  ].join('');

  const result = await runSecurity(['-i'], commands);
  if (result.code !== 0) throw new Error(`Keychain write failed (${result.code}): ${result.stderr.trim()}`);
  await deleteChunksFrom(account, chunks.length);
}

export async function readSecret(account: string): Promise<string | null> {
  assertSafeAccount(account);
  const head = await readItem(account);
  if (head === null) return null;
  const count = Number(/^chunks:(\d+)$/.exec(head)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error(`Corrupted keychain entry for ${account}`);

  const chunks = await Promise.all(
    Array.from({ length: count }, (_, index) => readItem(chunkItem(account, index))),
  );
  if (chunks.some((chunk) => chunk === null)) throw new Error(`Incomplete keychain entry for ${account}`);
  return Buffer.from(chunks.join(''), 'base64').toString('utf8');
}

export async function deleteSecret(account: string): Promise<void> {
  assertSafeAccount(account);
  await deleteItem(account);
  await deleteChunksFrom(account, 0);
}
