export type ProviderId = 'claude' | 'chatgpt' | 'grok';

export type Severity = 'normal' | 'warning' | 'critical';

export interface Limit {
  label: string;
  percent: number | null;
  resetsAt: Date | null;
  severity: Severity;
  detail?: string;
}

export interface Account {
  provider: ProviderId;
  label: string;
  identity?: string;
}

export const accountId = (account: Pick<Account, 'provider' | 'label'>): string =>
  `${account.provider}/${account.label}`;

export interface UsageSnapshot {
  plan?: string;
  limits: Limit[];
}

export type AccountUsage =
  | { account: Account; status: 'ok'; plan?: string; limits: Limit[] }
  | { account: Account; status: 'error'; message: string; hint?: string };

export interface LoginIO {
  print(message: string): void;
  prompt(question: string): Promise<string>;
  openUrl(url: string): Promise<void>;
}

export interface LoginResult<C> {
  credentials: C;
  identity?: string;
}

export interface Provider<C> {
  id: ProviderId;
  login(io: LoginIO): Promise<LoginResult<C>>;
  needsRefresh(credentials: C, now: Date): boolean;
  /** Throws AuthExpiredError when the provider rejects the refresh token. */
  refresh(credentials: C): Promise<C>;
  fetchUsage(credentials: C, signal: AbortSignal): Promise<UsageSnapshot>;
}

/** The stored login is no longer valid; the user has to log in again. */
export class AuthExpiredError extends Error {
  override name = 'AuthExpiredError';
}

/** The provider refused the request for a non-auth reason, e.g. a Cloudflare challenge. */
export class BlockedError extends Error {
  override name = 'BlockedError';
}
