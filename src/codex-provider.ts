/**
 * Codex Provider — wraps @openai/codex-sdk Codex class.
 *
 * Converts Codex ThreadEvent stream into the SSE format consumed by
 * the conversation engine (identical to what claude-provider.ts outputs).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire as nodeCreateRequire } from 'node:module';
import { Codex } from '@openai/codex-sdk';
import type {
  ThreadEvent,
  ThreadOptions,
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
} from '@openai/codex-sdk';
import type { StreamChatParams, FileAttachment } from './types.js';

// ── Resolve codex.exe path (same logic as SDK's findCodexPath) ──

const _codexRequire = nodeCreateRequire(import.meta.url);
let _resolvedCodexExe = '';

function resolveWin32CodexExe(): string {
  if (_resolvedCodexExe) return _resolvedCodexExe;

  // Try createRequire resolution (same as SDK's findCodexPath)
  try {
    const codexPkg = _codexRequire.resolve('@openai/codex/package.json');
    const codexReq = nodeCreateRequire(codexPkg);
    const platPkg = codexReq.resolve('@openai/codex-win32-x64/package.json');
    _resolvedCodexExe = path.join(
      path.dirname(platPkg), 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe',
    );
    if (fs.existsSync(_resolvedCodexExe)) return _resolvedCodexExe;
  } catch {
    // createRequire chain failed, try direct path
  }

  // Fallback: build path directly from known project structure
  const projectRoot = process.cwd();
  const directPath = path.join(
    projectRoot, 'node_modules', '@openai', 'codex-win32-x64',
    'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe',
  );
  if (fs.existsSync(directPath)) {
    _resolvedCodexExe = directPath;
    return _resolvedCodexExe;
  }

  return '';
}

// ── SSE helper ──

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

// ── Auth error detection ──

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run.*login/i,
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
  /403\b/,
];

export type AuthErrorKind = 'auth' | false;

export function classifyAuthError(text: string): AuthErrorKind {
  if (AUTH_PATTERNS.some((re) => re.test(text))) return 'auth';
  return false;
}

const AUTH_USER_MESSAGE =
  'Codex is not authenticated. ' +
  'Set OPENAI_API_KEY in your environment, or log in via `codex login`. ' +
  'Then restart the bridge.';

// ── Codex CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    // On Windows, .cmd/.bat wrappers may fail X_OK check — try execution instead
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

function getCliVersion(cliPath: string): string | undefined {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
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

export function preflightCheck(cliPath: string): {
  ok: boolean;
  version?: string;
  error?: string;
} {
  const version = getCliVersion(cliPath);
  if (!version) {
    return {
      ok: false,
      error: `codex CLI at "${cliPath}" failed to execute`,
    };
  }
  return { ok: true, version };
}

export function resolveCodexCliPath(): string | undefined {
  const fromEnv =
    process.env.CTI_CODEX_EXECUTABLE || process.env.CODEX_EXECUTABLE;
  if (
    fromEnv &&
    (process.platform !== 'win32' || path.extname(fromEnv).toLowerCase() === '.exe') &&
    isExecutable(fromEnv)
  ) {
    return fromEnv;
  }

  const pathCandidates = findAllInPath('codex');
  if (process.platform === 'win32') {
    const target = process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : process.arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : '';
    const platformPackage = process.arch === 'arm64'
      ? 'codex-win32-arm64'
      : process.arch === 'x64'
        ? 'codex-win32-x64'
        : '';
    const globalCodexExe = target && platformPackage
      ? path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
          platformPackage, 'vendor', target, 'bin', 'codex.exe',
        )
      : '';
    const executableCandidates = [
      globalCodexExe,
      ...pathCandidates.filter((p) => path.extname(p).toLowerCase() === '.exe'),
      resolveWin32CodexExe(),
    ];

    const seen = new Set<string>();
    for (const p of executableCandidates) {
      if (p && !seen.has(p)) {
        seen.add(p);
        if (isExecutable(p)) return p;
      }
    }
    return undefined;
  }

  const wellKnown = [
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    path.join(os.homedir(), 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];

  const seen = new Set<string>();
  const allCandidates = [...pathCandidates, ...wellKnown];
  for (const p of allCandidates) {
    if (p && !seen.has(p)) {
      seen.add(p);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const TMP_IMAGE_DIR = path.join(os.tmpdir(), 'codex-bridge-feishu-images');

function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | { type: 'text'; text: string }[] | { type: 'local_image'; path: string }[] {
  const imageFiles = files?.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const parts: ({ type: 'text'; text: string } | { type: 'local_image'; path: string })[] = [];

  for (const file of imageFiles) {
    fs.mkdirSync(TMP_IMAGE_DIR, { recursive: true });
    const safeName = path
      .basename(file.name)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpPath = path.join(TMP_IMAGE_DIR, `${Date.now()}-${safeName}`);
    fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
    parts.push({ type: 'local_image' as const, path: tmpPath });
  }

  if (text.trim()) {
    parts.push({ type: 'text' as const, text });
  }

  return parts as { type: 'text'; text: string }[] | { type: 'local_image'; path: string }[];
}

// ── CodexProvider ──

export class CodexProvider {
  private codexCliPath: string | undefined;
  private autoApprove: boolean;
  private resolvedCodexExe: string;

  constructor(cliPath?: string, autoApprove = false) {
    this.codexCliPath = cliPath;
    this.autoApprove = autoApprove;
    // Hard-resolve codex.exe on Windows — use both createRequire and direct path
    if (process.platform === 'win32') {
      this.resolvedCodexExe = resolveWin32CodexExe();
      // If resolution fails, use hardcoded fallback
      if (!this.resolvedCodexExe) {
        this.resolvedCodexExe = path.join(
          process.cwd(), 'node_modules', '@openai', 'codex-win32-x64',
          'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe',
        );
      }
    } else {
      this.resolvedCodexExe = '';
    }
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const autoApprove = this.autoApprove;
    const codexCliPath = this.codexCliPath;
    const resolvedCodexExe = this.resolvedCodexExe;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let lastAgentText = '';
          const seenToolIds = new Set<string>();
          let capturedThreadId: string | null = null;
          let hasReceivedResult = false;

          try {
            const codexOptions: Record<string, unknown> = {};

            // Prefer globally installed codex CLI (supports latest models)
            // Fall back to SDK-bundled binary for compatibility
            if (codexCliPath) {
              codexOptions.codexPathOverride = codexCliPath;
            } else if (process.platform === 'win32' && resolvedCodexExe) {
              codexOptions.codexPathOverride = resolvedCodexExe;
            }

            if (process.env.OPENAI_API_KEY) {
              codexOptions.apiKey = process.env.OPENAI_API_KEY;
            }
            if (process.env.OPENAI_BASE_URL) {
              codexOptions.baseUrl = process.env.OPENAI_BASE_URL;
            }
            if (process.platform === 'win32') {
              codexOptions.env = {
                ...process.env,
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
              };
            }

            const codex = new Codex(codexOptions);

            // MONKEY-PATCH: override executable path on Windows
            // Prefer global CLI; fall back to bundled binary
            if (process.platform === 'win32') {
              (codex as any).exec.executablePath = codexCliPath || resolvedCodexExe;
            }

            // Determine thread options
            const workDir = params.workingDirectory || process.cwd();
            const threadOpts: ThreadOptions = {
              workingDirectory: workDir,
              model: params.model || undefined,
              skipGitRepoCheck: true,
            };

            // Map permission mode to Codex approval policy
            if (autoApprove) {
              threadOpts.approvalPolicy = 'never';
              threadOpts.sandboxMode = 'danger-full-access';
            } else {
              // Without auto-approve, use on-request (Codex handles internally)
              threadOpts.approvalPolicy = 'on-request';
              threadOpts.sandboxMode = 'workspace-write';
            }

            // Start or resume thread
            const thread = params.sdkSessionId
              ? codex.resumeThread(params.sdkSessionId, threadOpts)
              : codex.startThread(threadOpts);

            const prompt = buildPrompt(params.prompt, params.files);

            const { events } = await thread.runStreamed(prompt, {
              signal: params.abortController?.signal,
            });

            for await (const event of events) {
              switch (event.type) {
                case 'thread.started':
                  capturedThreadId = event.thread_id;
                  controller.enqueue(
                    sseEvent('status', {
                      session_id: event.thread_id,
                      model:
                        params.model ||
                        process.env.CTI_CODEX_MODEL ||
                        undefined,
                    }),
                  );
                  break;

                case 'item.started':
                case 'item.updated':
                case 'item.completed': {
                  const item = event.item;

                  // Agent message — stream text deltas
                  if (item.type === 'agent_message') {
                    const msgItem = item as AgentMessageItem;
                    const delta = msgItem.text.slice(lastAgentText.length);
                    if (delta) {
                      lastAgentText = msgItem.text;
                      controller.enqueue(sseEvent('text', delta));
                    }
                  }

                  // Command execution (bash tool)
                  if (item.type === 'command_execution') {
                    const cmdItem = item as CommandExecutionItem;
                    if (!seenToolIds.has(cmdItem.id)) {
                      seenToolIds.add(cmdItem.id);
                      controller.enqueue(
                        sseEvent('tool_use', {
                          id: cmdItem.id,
                          name: 'bash',
                          input: { command: cmdItem.command },
                        }),
                      );
                    }
                    if (
                      event.type === 'item.completed' ||
                      (event.type === 'item.updated' &&
                        cmdItem.status === 'completed')
                    ) {
                      controller.enqueue(
                        sseEvent('tool_result', {
                          tool_use_id: cmdItem.id,
                          content: cmdItem.aggregated_output || '',
                          is_error: cmdItem.status === 'failed',
                        }),
                      );
                    }
                  }

                  // File change (write/edit tool)
                  if (item.type === 'file_change') {
                    const fcItem = item as FileChangeItem;
                    if (!seenToolIds.has(fcItem.id)) {
                      seenToolIds.add(fcItem.id);
                      const fileNames = fcItem.changes
                        .map((c) => c.path)
                        .join(', ');
                      controller.enqueue(
                        sseEvent('tool_use', {
                          id: fcItem.id,
                          name: 'file_edit',
                          input: { files: fileNames, changes: fcItem.changes },
                        }),
                      );
                    }
                    if (event.type === 'item.completed' || event.type === 'item.updated') {
                      const summary = fcItem.changes
                        .map((c) => `${c.kind}: ${c.path}`)
                        .join('\n');
                      controller.enqueue(
                        sseEvent('tool_result', {
                          tool_use_id: fcItem.id,
                          content: summary,
                          is_error: fcItem.status === 'failed',
                        }),
                      );

                      // On item.completed, emit file_output for each
                      // created/modified file so the bridge can upload
                      // results (images, documents, etc.) back to Feishu.
                      if (event.type === 'item.completed') {
                        for (const change of fcItem.changes) {
                          if (change.kind === 'delete') continue;
                          const absPath = path.resolve(workDir, change.path);
                          controller.enqueue(
                            sseEvent('file_output', {
                              path: absPath,
                              kind: change.kind,
                            }),
                          );
                        }
                      }
                    }
                  }

                  // MCP tool call
                  if (item.type === 'mcp_tool_call') {
                    const mcpItem = item as McpToolCallItem;
                    if (!seenToolIds.has(mcpItem.id)) {
                      seenToolIds.add(mcpItem.id);
                      controller.enqueue(
                        sseEvent('tool_use', {
                          id: mcpItem.id,
                          name: `mcp:${mcpItem.server}:${mcpItem.tool}`,
                          input: mcpItem.arguments,
                        }),
                      );
                    }
                    if (
                      event.type === 'item.completed' ||
                      (event.type === 'item.updated' &&
                        mcpItem.status !== 'in_progress')
                    ) {
                      const resultText = mcpItem.result
                        ? JSON.stringify(mcpItem.result.structured_content ?? mcpItem.result.content)
                        : mcpItem.error?.message || '';
                      controller.enqueue(
                        sseEvent('tool_result', {
                          tool_use_id: mcpItem.id,
                          content: resultText,
                          is_error:
                            mcpItem.status === 'failed' || !!mcpItem.error,
                        }),
                      );
                    }
                  }

                  // Web search — track as tool
                  if (item.type === 'web_search') {
                    if (!seenToolIds.has(item.id)) {
                      seenToolIds.add(item.id);
                      controller.enqueue(
                        sseEvent('tool_use', {
                          id: item.id,
                          name: 'web_search',
                          input: { query: item.query },
                        }),
                      );
                    }
                    if (event.type === 'item.completed') {
                      controller.enqueue(
                        sseEvent('tool_result', {
                          tool_use_id: item.id,
                          content: `Searched: ${item.query}`,
                          is_error: false,
                        }),
                      );
                    }
                  }

                  // Reasoning — stream as text (optional, prefixed)
                  if (item.type === 'reasoning') {
                    // Reasoning is internal, skip or optionally stream
                  }

                  break;
                }

                case 'turn.completed':
                  hasReceivedResult = true;
                  capturedThreadId = capturedThreadId || thread.id || '';
                  controller.enqueue(
                    sseEvent('result', {
                      session_id: capturedThreadId,
                      is_error: false,
                      usage: {
                        input_tokens: event.usage.input_tokens,
                        output_tokens: event.usage.output_tokens,
                        cache_read_input_tokens:
                          event.usage.cached_input_tokens ?? 0,
                        cache_creation_input_tokens: 0,
                      },
                    }),
                  );
                  break;

                case 'turn.failed':
                  hasReceivedResult = true;
                  controller.enqueue(
                    sseEvent('error', event.error.message),
                  );
                  break;

                case 'error':
                  controller.enqueue(
                    sseEvent('error', event.message),
                  );
                  break;
              }
            }

            controller.close();
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            console.error(
              '[codex-provider] Error:',
              err instanceof Error ? err.stack || err.message : err,
            );

            if (hasReceivedResult) {
              controller.close();
              return;
            }

            const authKind =
              classifyAuthError(message) ||
              classifyAuthError(
                err instanceof Error ? err.stack || '' : '',
              );
            if (authKind === 'auth') {
              controller.enqueue(sseEvent('error', AUTH_USER_MESSAGE));
              controller.close();
              return;
            }

            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }
}
