import { deleteSecret, readSecret, writeSecret } from './keychain.ts';

export async function loadCredentials<C>(id: string): Promise<C | null> {
  const raw = await readSecret(id);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as C;
  } catch {
    throw new Error(`Stored login for ${id} is corrupted; run: aiu login ${id.replace('/', ' --name ')}`);
  }
}

export async function saveCredentials<C>(id: string, credentials: C): Promise<void> {
  await writeSecret(id, JSON.stringify(credentials));
}

export async function deleteCredentials(id: string): Promise<void> {
  await deleteSecret(id);
}
