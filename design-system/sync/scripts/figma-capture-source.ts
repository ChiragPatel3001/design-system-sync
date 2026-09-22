/**
 * FigmaCaptureSource — the pluggable boundary that produces a
 * `RawFigmaCapture` (figma-snapshot-types.ts's existing, unmodified
 * shape) without figma-snapshot.ts or anything downstream of it knowing
 * or caring where that capture came from:
 *
 *   FigmaCaptureSource
 *         |
 *   RawFigmaCapture                     <- existing shape, unchanged
 *         |
 *   buildFigmaSnapshot()                <- existing, unchanged
 *         |
 *   FigmaSnapshot -> reconciliation     <- existing, unchanged
 *
 * This module owns exactly one job: obtaining a `RawFigmaCapture`. It
 * never builds a FigmaSnapshot, never compares anything, never decides
 * what a change means — see figma-snapshot.ts / reconcile-compare.ts for
 * why that separation matters here too.
 *
 * Two implementations:
 *
 *   createStaticCaptureSource(capture)
 *     Wraps an already-known RawFigmaCapture (e.g. read from disk, or a
 *     test fixture). No I/O, no network, fully deterministic — this is
 *     what tests inject, mirroring this project's established
 *     mock-client pattern (see agent-claude-reasoner.ts's
 *     createMockClaudeClient).
 *
 *   createFigmaDevModeMcpCaptureSource(options)
 *     The real, live adapter. Talks to Figma's own Dev Mode MCP Server —
 *     a local HTTP server the Figma desktop app runs when Dev Mode MCP
 *     is enabled for a file (see
 *     https://developers.figma.com/docs/figma-mcp-server/). This is a
 *     genuine Figma product feature, independent of any Claude/agent
 *     tool-calling session — verified live and reachable at
 *     http://127.0.0.1:3845/mcp while building this adapter (see the
 *     accompanying report for the exact verification transcript: a real
 *     `initialize` handshake, and a real `get_variable_defs` tool call
 *     against node 15:664 that returned the file's actual current
 *     variable values). It is NOT the same thing as
 *     `mcp__claude_ai_Figma__*` (Claude's own hosted connector, only
 *     reachable from inside an interactive agent session) — this talks
 *     to Figma's local server directly over plain HTTP, which is exactly
 *     what makes it usable from an unattended `node reconcile.ts`
 *     process.
 *
 *     Deliberately narrow scope: it refreshes ONLY the `variableDefs` of
 *     the component node ids the PREVIOUS capture already knew about —
 *     never rediscovers pages, sections, the component list, dimensions,
 *     or variant symbols. Token/variable VALUES are what actually needs
 *     to be fresh on every reconciliation run; the file's structural
 *     shape changes far less often and was already captured once (the
 *     one-time, agent-assisted investigation figma-snapshots/README.md
 *     documents). This keeps the adapter small and the number of live
 *     calls proportional to the existing component count, not the
 *     unbounded size of the whole file.
 *
 *     No credential/token is required for this mechanism — the Dev Mode
 *     MCP Server authenticates via the already-signed-in Figma desktop
 *     app, not a bearer token this script would need to hold. The only
 *     configuration is *where* the server is (FIGMA_MCP_SERVER_URL),
 *     which is not a secret and is safe to default.
 */
import type { RawFigmaCapture, RawFigmaComponentCapture } from './figma-snapshot-types.ts';

export class FigmaCaptureError extends Error {}

export interface FigmaCaptureSource {
  capture(): Promise<RawFigmaCapture>;
}

/** Deterministic, no I/O — wraps an already-known capture. Used for tests and as the trivial "reuse what's on disk" case. */
export function createStaticCaptureSource(capture: RawFigmaCapture): FigmaCaptureSource {
  return {
    async capture(): Promise<RawFigmaCapture> {
      return capture;
    },
  };
}

// =======================================================================
// Figma Dev Mode MCP Server client — a minimal MCP-over-HTTP JSON-RPC
// client using only native `fetch` (no new dependency). Implements just
// the three calls this adapter needs: `initialize`, the
// `notifications/initialized` handshake notification, and `tools/call`.
// Never a general-purpose MCP client — see module header.
// =======================================================================

export const DEFAULT_FIGMA_MCP_SERVER_URL = 'http://127.0.0.1:3845/mcp';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The server responds either as a single `application/json` body or as one `event: message\ndata: <json>` SSE frame — this handles both without assuming a persistent stream (see module header on why: `initialize` and `tools/call` were both observed to resolve in one self-contained frame, never a long-lived push stream, in the live verification this adapter is based on). */
function parseMcpResponseBody(rawText: string, contentType: string | null): JsonRpcResponse {
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(rawText) as JsonRpcResponse;
    } catch {
      throw new FigmaCaptureError(`Figma Dev Mode MCP Server returned malformed JSON: ${rawText.slice(0, 200)}`);
    }
  }

  const dataLines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) {
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server response contained no parseable data (content-type: ${contentType ?? 'unknown'}): ${rawText.slice(0, 200)}`);
  }
  const lastDataLine = dataLines[dataLines.length - 1].slice('data:'.length).trim();
  try {
    return JSON.parse(lastDataLine) as JsonRpcResponse;
  } catch {
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server returned a malformed event-stream payload: ${lastDataLine.slice(0, 200)}`);
  }
}

interface McpTransportOptions {
  serverUrl: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
}

async function postMcpMessage(
  options: McpTransportOptions,
  sessionId: string | null,
  body: Record<string, unknown>,
  expectResponse: boolean,
): Promise<JsonRpcResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);

  let response: Response;
  try {
    response = await options.fetchImpl(options.serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new FigmaCaptureError(
      `Could not reach the Figma Dev Mode MCP Server at ${options.serverUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Make sure the Figma desktop app is open with Dev Mode MCP Server enabled for this file (see https://developers.figma.com/docs/figma-mcp-server/), ' +
        'or set FIGMA_MCP_SERVER_URL if it is running somewhere other than the default port.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server request failed: ${response.status} ${response.statusText}. ${text}`.trim());
  }

  if (!expectResponse) {
    return null; // fire-and-forget notification (e.g. notifications/initialized) — no JSON-RPC response expected
  }

  const contentType = response.headers.get('content-type');
  const rawText = await response.text();
  const parsed = parseMcpResponseBody(rawText, contentType);

  if (parsed.error) {
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server returned an error: ${parsed.error.message} (code ${parsed.error.code})`);
  }

  return parsed;
}

let requestCounter = 0;
function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

async function initializeMcpSession(options: McpTransportOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);

  let response: Response;
  try {
    response = await options.fetchImpl(options.serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextRequestId(),
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'design-system-sync-figma-capture', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new FigmaCaptureError(
      `Could not reach the Figma Dev Mode MCP Server at ${options.serverUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Make sure the Figma desktop app is open with Dev Mode MCP Server enabled for this file (see https://developers.figma.com/docs/figma-mcp-server/), ' +
        'or set FIGMA_MCP_SERVER_URL if it is running somewhere other than the default port.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server rejected the initialize handshake: ${response.status} ${response.statusText}. ${text}`.trim());
  }

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new FigmaCaptureError('Figma Dev Mode MCP Server did not return an Mcp-Session-Id header during initialize — cannot establish a session.');
  }

  const contentType = response.headers.get('content-type');
  const rawText = await response.text();
  const parsed = parseMcpResponseBody(rawText, contentType);
  if (parsed.error) {
    throw new FigmaCaptureError(`Figma Dev Mode MCP Server rejected the initialize handshake: ${parsed.error.message} (code ${parsed.error.code})`);
  }

  await postMcpMessage(options, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, false);

  return sessionId;
}

/** Calls the `get_variable_defs` tool for one node — the same tool/argument shape the original manual MCP investigation used (see figma-snapshots/README.md), just invoked over HTTP instead of an agent's tool-calling session. Fails closed on anything other than a flat `{[name: string]: string}` result. */
async function callGetVariableDefs(options: McpTransportOptions, sessionId: string, nodeId: string): Promise<Record<string, string>> {
  const response = await postMcpMessage(
    options,
    sessionId,
    { jsonrpc: '2.0', id: nextRequestId(), method: 'tools/call', params: { name: 'get_variable_defs', arguments: { nodeId } } },
    true,
  );

  const result = response?.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  if (!result) {
    throw new FigmaCaptureError(`get_variable_defs(${nodeId}) returned no result.`);
  }
  if (result.isError) {
    throw new FigmaCaptureError(`get_variable_defs(${nodeId}) returned a tool-level error: ${JSON.stringify(result.content)}`);
  }
  const textBlock = result.content?.find((block) => block.type === 'text' && typeof block.text === 'string');
  if (!textBlock?.text) {
    throw new FigmaCaptureError(`get_variable_defs(${nodeId}) response contained no text content block.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new FigmaCaptureError(`get_variable_defs(${nodeId}) returned text that was not valid JSON: ${textBlock.text.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FigmaCaptureError(`get_variable_defs(${nodeId}) did not return a flat object of variable definitions.`);
  }
  const record = parsed as Record<string, unknown>;
  const result2: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw new FigmaCaptureError(`get_variable_defs(${nodeId}) returned a non-string value for "${key}" — refusing to fabricate a coercion.`);
    }
    result2[key] = value;
  }
  return result2;
}

export interface FigmaDevModeMcpCaptureSourceOptions {
  /** The previous/existing RawFigmaCapture — supplies the fixed set of component node ids to refresh, and every structural field (pages, sections, variant symbols, dimensions, textStyleVariableDefs) this adapter deliberately does not rediscover. */
  previousCapture: RawFigmaCapture;
  /** Defaults to DEFAULT_FIGMA_MCP_SERVER_URL. Not a secret — just where the local server is. */
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export function createFigmaDevModeMcpCaptureSource(options: FigmaDevModeMcpCaptureSourceOptions): FigmaCaptureSource {
  const transport: McpTransportOptions = {
    serverUrl: options.serverUrl ?? DEFAULT_FIGMA_MCP_SERVER_URL,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };

  return {
    async capture(): Promise<RawFigmaCapture> {
      const sessionId = await initializeMcpSession(transport);

      const components: RawFigmaComponentCapture[] = [];
      for (const component of options.previousCapture.components) {
        const variableDefs = await callGetVariableDefs(transport, sessionId, component.figmaNodeId);
        components.push({ ...component, variableDefs });
      }

      return {
        ...options.previousCapture,
        $note:
          'Auto-refreshed by createFigmaDevModeMcpCaptureSource (figma-capture-source.ts) via the local Figma Dev Mode MCP Server — variable values only; structural fields (pages, sections, variant symbols, dimensions, textStyleVariableDefs) carried over unchanged from the previous capture.',
        capturedAt: new Date().toISOString(),
        capturedVia: [...options.previousCapture.capturedVia, `figma-capture-source.ts: get_variable_defs (per-component node id, x${components.length}) via ${transport.serverUrl}`],
        components,
      };
    },
  };
}
