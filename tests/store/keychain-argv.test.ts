import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const calls: { args: string[]; stdin: string }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const call = { args, stdin: '' };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: (chunk: string) => {
          call.stdin += chunk;
          return true;
        },
        end: () => undefined,
      },
    });
    const isLookup = args[0] === 'find-generic-password' || args[0] === 'delete-generic-password';
    setImmediate(() => child.emit('close', isLookup ? 44 : 0));
    return child;
  },
}));

const { writeSecret } = await import('../../src/store/keychain.ts');

describe('keychain store argv safety', () => {
  it('never passes the secret (or its encoded chunks) as a process argument', async () => {
    const secret = 'super-secret-refresh-token-value';
    await writeSecret('claude/personal', secret);

    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const allArgs = calls.flatMap((call) => call.args);
    expect(allArgs.some((arg) => arg.includes(secret) || arg.includes(encoded))).toBe(false);
    expect(calls.some((call) => call.stdin.includes(encoded))).toBe(true);
  });
});
