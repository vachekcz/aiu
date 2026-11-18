import type { withFileLock } from './lock.ts';
import {
  accountId,
  AuthExpiredError,
  BlockedError,
  type Account,
  type AccountUsage,
  type Provider,
  type ProviderId,
} from './types.ts';

export interface CollectDeps {
  providers: Partial<Record<ProviderId, Provider<unknown>>>;
  loadCredentials: (id: string) => Promise<unknown | null>;
  saveCredentials: (id: string, credentials: unknown) => Promise<void>;
  now: () => Date;
  timeoutMs: number;
  lock: typeof withFileLock;
}

class MissingCredentialsError extends Error {}
class TimeoutError extends Error {}

const loginHint = (account: Account) => `aiu login ${account.provider} --name ${account.label}`;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchAccount(account: Account, provider: Provider<unknown>, deps: CollectDeps) {
  const id = accountId(account);
  // Load inside the lock: a concurrent run may just have rotated the tokens.
  return deps.lock(
    id.replaceAll('/', '__'),
    async () => {
      let credentials = await deps.loadCredentials(id);
      if (credentials === null) throw new MissingCredentialsError();

      const refresh = async () => {
        credentials = await provider.refresh(credentials);
        await deps.saveCredentials(id, credentials);
      };

      let refreshed = false;
      if (provider.needsRefresh(credentials, deps.now())) {
        await refresh();
        refreshed = true;
      }
      const fetchOnce = () => provider.fetchUsage(credentials, AbortSignal.timeout(deps.timeoutMs));
      try {
        return await fetchOnce();
      } catch (error) {
        if (!(error instanceof AuthExpiredError) || refreshed) throw error;
        await refresh();
        return fetchOnce();
      }
    },
    { timeoutMs: deps.timeoutMs },
  );
}

function errorUsage(account: Account, error: unknown): AccountUsage {
  const row = (message: string, hint?: string): AccountUsage => ({
    account,
    status: 'error',
    message,
    ...(hint ? { hint } : {}),
  });
  if (error instanceof MissingCredentialsError) return row('No credentials stored', loginHint(account));
  if (error instanceof AuthExpiredError) return row('Login expired', loginHint(account));
  if (error instanceof BlockedError) return row('Unavailable (blocked)');
  if (error instanceof TimeoutError || (error instanceof Error && error.name === 'TimeoutError')) {
    return row('Timed out');
  }
  return row(error instanceof Error ? error.message : String(error));
}

export async function collectUsage(accounts: Account[], deps: CollectDeps): Promise<AccountUsage[]> {
  return Promise.all(
    accounts.map(async (account): Promise<AccountUsage> => {
      const provider = deps.providers[account.provider];
      if (!provider) return { account, status: 'error', message: 'Unknown provider' };
      try {
        const snapshot = await withTimeout(fetchAccount(account, provider, deps), deps.timeoutMs);
        return { account, status: 'ok', ...(snapshot.plan ? { plan: snapshot.plan } : {}), limits: snapshot.limits };
      } catch (error) {
        return errorUsage(account, error);
      }
    }),
  );
}
