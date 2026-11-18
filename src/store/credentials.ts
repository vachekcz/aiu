import { deleteSecret, readSecret, writeSecret } from './keychain.ts';

export async function loadCredentials<C>(id: string): Promise<C | null> {
  const raw = await readSecret(id);
  return raw === null ? null : (JSON.parse(raw) as C);
}

export async function saveCredentials<C>(id: string, credentials: C): Promise<void> {
  await writeSecret(id, JSON.stringify(credentials));
}

export async function deleteCredentials(id: string): Promise<void> {
  await deleteSecret(id);
}
