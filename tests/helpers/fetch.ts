import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Replaces the global fetch for every test of the file, so no test can reach a real endpoint: an
 * unprepared call resolves to undefined and fails in the provider. With `now`, the clock (Date only)
 * is frozen there as well.
 */
export function stubFetch(options: { now?: Date } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    if (!options.now) return;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(options.now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  return fetchMock;
}
