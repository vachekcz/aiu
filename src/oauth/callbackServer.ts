import { createServer } from 'node:http';

export interface CallbackOptions {
  port: number;
  path: string;
  expectedState: string;
  timeoutMs: number;
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>aiu</title><p style="font-family:system-ui">${message}</p>`;

/**
 * One-shot local HTTP server receiving the OAuth redirect.
 * `ready` settles once the port is bound; `code` resolves with the authorization code.
 */
export function waitForOAuthCallback(options: CallbackOptions): { ready: Promise<void>; code: Promise<string> } {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Callers may await `ready` first; a failed bind must not surface as an unhandled rejection here.
  code.catch(() => undefined);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${options.port}`);
    if (url.pathname !== options.path) {
      response.writeHead(404).end();
      return;
    }
    const finish = (status: number, message: string, outcome: () => void) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(page(message));
      clearTimeout(timer);
      server.close();
      outcome();
    };
    const receivedCode = url.searchParams.get('code');
    if (url.searchParams.get('state') !== options.expectedState || !receivedCode) {
      finish(400, 'Login failed: state mismatch. Return to the terminal.', () =>
        rejectCode(new Error('OAuth state mismatch')),
      );
      return;
    }
    finish(200, 'Login complete. You can close this tab and return to the terminal.', () => resolveCode(receivedCode));
  });

  const timer = setTimeout(() => {
    server.close();
    rejectCode(new Error('Timed out waiting for the browser login'));
  }, options.timeoutMs);

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const failure =
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${options.port} is busy — is \`codex login\` running?`)
          : error;
      rejectCode(failure);
      reject(failure);
    });
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  return { ready, code };
}
