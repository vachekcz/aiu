import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const calls: { args: string[]; stdin: string }[] = [];
let interactiveStderr = '';

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
    setImmediate(() => {
      if (args[0] === '-i' && interactiveStderr) child.stderr.emit('data', Buffer.from(interactiveStderr));
      child.emit('close', isLookup ? 44 : 0);
    });
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

  it('never passes any chunk of a multi-chunk secret as a process argument', async () => {
    calls.length = 0;
    const secret = randomBytes(6000).toString('base64');
    await writeSecret('claude/personal', secret);

    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const chunks = encoded.match(/.{1,3000}/g)!;
    expect(chunks.length).toBeGreaterThan(1);
    const allArgs = calls.flatMap((call) => call.args).join('\n');
    chunks.forEach((chunk) => {
      expect(allArgs).not.toContain(chunk);
      expect(calls.some((call) => call.stdin.includes(chunk))).toBe(true);
    });
  });

  it('rejects a service name that would change the security -i command', async () => {
    process.env.AI_USAGE_KEYCHAIN_SERVICE = 'x" -a "other';
    try {
      await expect(writeSecret('claude/personal', 'value')).rejects.toThrow('Invalid keychain service name');
    } finally {
      delete process.env.AI_USAGE_KEYCHAIN_SERVICE;
    }
  });

  it('fails when a command inside `security -i` fails although the exit code is 0', async () => {
    interactiveStderr = 'add-generic-password: returned -25299\n';
    try {
      await expect(writeSecret('claude/personal', 'value')).rejects.toThrow('Keychain write failed');
    } finally {
      interactiveStderr = '';
    }
  });
});
