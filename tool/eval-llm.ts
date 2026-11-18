// LLM access for the command-line tools (the engine lab, tool/lab): a
// "Sign in with ChatGPT" session stored outside the repository
// (~/.config/what-to-watch/eval-credentials.json, owner-only).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Server, createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AuthPlatform, ChatGptAuth, Loopback, SecretStore } from '../src/core/auth';

class FileSecretStore implements SecretStore {
  private path = join(homedir(), '.config', 'what-to-watch', 'eval-credentials.json');
  private data: Record<string, string> = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  async read(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }
  async write(key: string, value: string | null): Promise<void> {
    if (value === null) delete this.data[key];
    else this.data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(`${this.path}.tmp`, 0o600);
    renameSync(`${this.path}.tmp`, this.path);
  }
}

class NodeLoopback implements Loopback {
  private server?: Server;
  private resolve?: (q: string) => void;
  private reject?: (e: Error) => void;
  private result?: Promise<string>;

  start(opts: { path: string; state: string; okHtml: string; failHtml: string }): Promise<number> {
    this.stop();
    this.result = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.result.catch(() => {});
    return new Promise((ready, fail) => {
      const server = (this.server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== opts.path) {
          res.writeHead(404).end();
          return;
        }
        const ok = !url.searchParams.get('error') && url.searchParams.get('state') === opts.state;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? opts.okHtml : opts.failHtml);
        this.resolve?.(url.search.slice(1));
      }));
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => ready((server.address() as { port: number }).port));
    });
  }
  wait(): Promise<string> {
    return this.result ?? Promise.reject(new Error('not started'));
  }
  stop(): void {
    this.reject?.(new Error('stopped'));
    this.server?.close();
    this.server = undefined;
  }
}

const adbPath = join(homedir(), 'Library/Android/sdk/platform-tools/adb');

export function platform(adb = false): AuthPlatform {
  return {
    store: new FileSecretStore(),
    loopback: new NodeLoopback(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    openBrowser: async (url) => {
      if (adb) {
        // The browser step happens on the connected Android device; its
        // loopback port is forwarded to this machine.
        const port = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
        execFileSync(adbPath, ['reverse', `tcp:${port}`, `tcp:${port}`]);
        execFileSync(adbPath, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`]);
        console.error(`Opened the sign-in page on the Android device (port ${port}).`);
      } else {
        console.error('Opening the browser to sign in…');
        execFileSync('open', [url]);
      }
      return 'opened';
    },
  };
}

export async function evalSignIn(adb = false): Promise<void> {
  const auth = new ChatGptAuth(platform(adb));
  await auth.load();
  await auth.signIn();
  console.log(`Signed in as ${auth.email}.`);
}
