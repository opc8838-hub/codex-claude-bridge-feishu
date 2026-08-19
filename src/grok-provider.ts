/**
 * Grok Provider — long-lived `grok agent stdio` ACP client.
 *
 * Translates ACP session/update notifications into the same SSE
 * format conversation.ts already consumes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams } from './types.js';
import {
  buildAcpPrompt,
  mapAcpUpdateToSse,
  modeRules,
  sseEvent,
  usageFromNotification,
} from './grok-acp.js';

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type SessionHandler = (msg: JsonRpcMessage) => void;

function isExecutable(p: string): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`"${p}" --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findAllInPath(binary: string): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync(`where ${binary}`, { encoding: 'utf-8', timeout: 3000 })
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    return execSync(`which -a ${binary}`, { encoding: 'utf-8', timeout: 3000 })
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveGrokCliPath(): string | undefined {
  const fromEnv = process.env.CTI_GROK_EXECUTABLE || process.env.GROK_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const homeBin = path.join(os.homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  const wellKnown = [
    homeBin,
    path.join(os.homedir(), '.local', 'bin', 'grok'),
    path.join(os.homedir(), 'bin', 'grok'),
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
  ];

  const pathHits = findAllInPath(process.platform === 'win32' ? 'grok.exe' : 'grok');
  const seen = new Set<string>();
  for (const p of [...pathHits, ...wellKnown]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    const version = execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!version) return { ok: false, error: `grok CLI at "${cliPath}" returned empty version` };
    return { ok: true, version };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `grok CLI at "${cliPath}" failed to execute`,
    };
  }
}

export function classifyAuthError(text: string): 'auth' | false {
  if (/not logged in|please run.*login|unauthorized|invalid.*token|authentication.*failed|401\b/i.test(text)) {
    return 'auth';
  }
  return false;
}

const AUTH_USER_MESSAGE =
  'Grok CLI is not logged in. Run `grok login`, then restart the bridge.';

class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private sessionHandlers = new Map<string, Set<SessionHandler>>();
  private started = false;

  constructor(
    private cliPath: string,
    private pendingPerms: PendingPermissions,
    private defaultModel?: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    const args = ['agent', '--no-leader'];
    if (this.defaultModel) args.push('--model', this.defaultModel);
    args.push('stdio');

    this.proc = spawn(this.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) console.warn('[grok-acp] stderr:', text.slice(0, 500));
    });
    this.proc.on('exit', (code, signal) => {
      this.started = false;
      const err = new Error(`grok agent exited (code=${code}, signal=${signal})`);
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
    });

    this.started = true;

    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
      clientInfo: { name: 'feishu-grok-bridge', version: '1.0.0' },
    });
    await this.request('authenticate', { methodId: 'cached_token' });
  }

  onSession(sessionId: string, handler: SessionHandler): () => void {
    let set = this.sessionHandlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionHandlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  async request(method: string, params?: unknown, timeoutMs = 180_000): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error('ACP client is not running');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return result;
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.request('session/cancel', { sessionId }, 10_000);
    } catch (err) {
      console.warn('[grok-acp] session/cancel failed:', err instanceof Error ? err.message : err);
    }
  }

  close(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch { /* ignore */ }
    this.proc.kill();
    this.proc = null;
    this.started = false;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        console.warn('[grok-acp] non-JSON line:', trimmed.slice(0, 200));
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
      const waiter = this.pending.get(Number(msg.id));
      this.pending.delete(Number(msg.id));
      if (msg.error) {
        waiter?.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        waiter?.resolve(msg.result);
      }
      return;
    }

    if (msg.method && msg.id !== undefined) {
      await this.handleAgentRequest(msg);
      return;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (sessionId) {
      const handlers = this.sessionHandlers.get(sessionId);
      if (handlers) {
        for (const handler of handlers) handler(msg);
      }
    }
  }

  private async handleAgentRequest(msg: JsonRpcMessage): Promise<void> {
    const id = msg.id;
    const method = msg.method || '';
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === 'session/request_permission') {
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const toolUseId = String(toolCall.toolCallId ?? toolCall.id ?? `perm-${id}`);
      const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
      const allow = options.find((o) => String(o.kind ?? o.optionId ?? '').includes('allow'))
        ?? options[0];
      const deny = options.find((o) => String(o.kind ?? o.optionId ?? '').includes('reject') || String(o.kind ?? '').includes('deny'))
        ?? options[1];

      const sessionId = String(params.sessionId ?? '');
      const handlers = this.sessionHandlers.get(sessionId);
      if (handlers) {
        const fake: JsonRpcMessage = {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: '_permission',
              permissionRequestId: toolUseId,
              toolName: String(toolCall.title ?? toolCall.kind ?? 'tool'),
              toolInput: toolCall.rawInput ?? {},
            },
          },
        };
        for (const handler of handlers) handler(fake);
      }

      const result = await this.pendingPerms.waitFor(toolUseId);
      const optionId = result.behavior === 'allow'
        ? String(allow?.optionId ?? 'allow_once')
        : String(deny?.optionId ?? 'reject_once');
      this.respond(id, { outcome: { outcome: 'selected', optionId } });
      return;
    }

    if (method === 'fs/read_text_file') {
      const filePath = String(params.path ?? '');
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        this.respond(id, { content: text });
      } catch (err) {
        this.respondError(id, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    this.respondError(id, `Unsupported client method: ${method}`);
  }

  private respond(id: number | string | undefined, result: unknown): void {
    if (id === undefined || !this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private respondError(id: number | string | undefined, message: string): void {
    if (id === undefined || !this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message },
    }) + '\n');
  }
}

export class GrokProvider {
  private client: AcpClient | null = null;
  private startPromise: Promise<AcpClient> | null = null;

  constructor(
    private cliPath: string,
    private autoApprove: boolean,
    private pendingPerms: PendingPermissions,
    private defaultModel?: string,
  ) {}

  async ensureStarted(): Promise<AcpClient> {
    if (this.client) return this.client;
    if (!this.startPromise) {
      this.startPromise = (async () => {
        const client = new AcpClient(this.cliPath, this.pendingPerms, this.defaultModel);
        await client.start();
        this.client = client;
        return client;
      })().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  close(): void {
    this.client?.close();
    this.client = null;
    this.startPromise = null;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const autoApprove = params.autoApprove !== undefined ? params.autoApprove : this.autoApprove;
    const self = this;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let capturedSessionId = params.sdkSessionId || '';
          let lastUsage: ReturnType<typeof usageFromNotification> = null;
          let unsub: (() => void) | undefined;

          const onAbort = () => {
            if (capturedSessionId) {
              void self.client?.cancel(capturedSessionId);
            }
          };
          params.abortController?.signal.addEventListener('abort', onAbort);

          try {
            const client = await self.ensureStarted();

            const attach = (sessionId: string) => {
              capturedSessionId = sessionId;
              unsub = client.onSession(sessionId, (msg) => {
                const method = msg.method || '';
                const rec = (msg.params ?? {}) as Record<string, unknown>;

                if (method === '_x.ai/session_notification') {
                  const usage = usageFromNotification(rec.update ?? rec);
                  if (usage) lastUsage = usage;
                  return;
                }

                if (method !== 'session/update') return;
                const update = (rec.update ?? {}) as Record<string, unknown>;
                if (update.sessionUpdate === '_permission') {
                  controller.enqueue(sseEvent('permission_request', {
                    permissionRequestId: update.permissionRequestId,
                    toolName: update.toolName,
                    toolInput: update.toolInput ?? {},
                    suggestions: [],
                  }));
                  return;
                }
                for (const piece of mapAcpUpdateToSse(update)) {
                  controller.enqueue(sseEvent(piece.type, piece.data));
                }
              });
            };

            if (params.sdkSessionId) {
              try {
                const loaded = await client.request('session/load', {
                  sessionId: params.sdkSessionId,
                  cwd: params.workingDirectory || process.cwd(),
                  mcpServers: [],
                }) as { sessionId?: string };
                attach(loaded?.sessionId || params.sdkSessionId);
              } catch (err) {
                console.warn(
                  '[grok-provider] session/load failed, creating new session:',
                  err instanceof Error ? err.message : err,
                );
                capturedSessionId = '';
              }
            }

            if (!capturedSessionId) {
              const created = await client.request('session/new', {
                cwd: params.workingDirectory || process.cwd(),
                mcpServers: [],
                _meta: {
                  yoloMode: autoApprove,
                  rules: modeRules(params.permissionMode),
                },
              }) as { sessionId: string };
              attach(created.sessionId);
              controller.enqueue(sseEvent('status', {
                session_id: created.sessionId,
                model: params.model || self.defaultModel,
              }));
            } else {
              controller.enqueue(sseEvent('status', {
                session_id: capturedSessionId,
                model: params.model || self.defaultModel,
              }));
            }

            const prompt = buildAcpPrompt(params.prompt, params.files);
            await client.request('session/prompt', {
              sessionId: capturedSessionId,
              prompt,
            }, 10 * 60_000);

            controller.enqueue(sseEvent('result', {
              session_id: capturedSessionId,
              is_error: false,
              usage: lastUsage ?? {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            }));
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[grok-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            if (classifyAuthError(message) === 'auth') {
              controller.enqueue(sseEvent('error', AUTH_USER_MESSAGE));
            } else {
              controller.enqueue(sseEvent('error', message));
            }
            controller.close();
          } finally {
            unsub?.();
            params.abortController?.signal.removeEventListener('abort', onAbort);
          }
        })();
      },
    });
  }
}
