import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStaticCaptureSource, createFigmaDevModeMcpCaptureSource, FigmaCaptureError } from './figma-capture-source.ts';
import type { RawFigmaCapture } from './figma-snapshot-types.ts';

// =======================================================================
// Deterministic fixture. Two components, mirroring the real repository's
// shape (RawFigmaCapture / RawFigmaComponentCapture, unmodified) closely
// enough to be representative without depending on the real file.
// =======================================================================

function makePreviousCapture(): RawFigmaCapture {
  return {
    captureSchemaVersion: '1.0.0',
    fileKey: 'fixture-file-key',
    fileName: 'Fixture Design System',
    capturedAt: '2026-01-01T00:00:00.000Z',
    capturedVia: ['manual mcp investigation'],
    pagesFromNoNodeIdListing: [],
    pagesConfirmedByDirectRead: [{ id: '0:1', name: 'Tokens' }],
    sections: { '17:80': 'Buttons' },
    components: [
      {
        figmaNodeId: '15:664',
        name: 'Button',
        nodeType: 'frame',
        sectionId: '17:80',
        width: 844,
        height: 346,
        variantSymbols: [{ nodeId: '14:595', name: 'State=Default, Type=Default', width: 139, height: 40 }],
        variableDefs: { 'Paragraph Medium/Line Height': '20' },
      },
      {
        figmaNodeId: '18:130',
        name: 'FieldLabel',
        nodeType: 'symbol',
        sectionId: null,
        width: 100,
        height: 20,
        variantSymbols: [],
        variableDefs: { 'Paragraph Medium/Line Height': '20' },
      },
    ],
    textStyleVariableDefs: { 'Body/Medium': 'Font(family: "Inter", style: Regular, size: 16, weight: 400, lineHeight: 20, letterSpacing: 0)' },
  };
}

/** Builds a deterministic mock `fetch` that responds to the exact MCP call sequence this adapter makes (initialize -> notifications/initialized -> tools/call x N), formatted as the real server's `event: message\ndata: <json>` SSE frames — matching what was observed live against the real Figma Dev Mode MCP Server while building this adapter. `variableDefsByNode` supplies the response for each `get_variable_defs` call by nodeId. */
function makeMockFetch(variableDefsByNode: Record<string, Record<string, string> | 'ERROR' | 'BAD_JSON' | 'NON_STRING'>, opts: { omitSessionId?: boolean; networkFailure?: boolean } = {}): typeof fetch {
  let requestId = 0;
  return (async (_url: string, init?: RequestInit) => {
    if (opts.networkFailure) {
      throw new Error('ECONNREFUSED: simulated — no server listening');
    }
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (body.method === 'initialize') {
      const headers = new Headers({ 'content-type': 'text/event-stream' });
      if (!opts.omitSessionId) headers.set('mcp-session-id', 'fixture-session-123');
      const payload = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'Figma Dev Mode MCP Server (fixture)', version: '1.0.0' } } };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers });
    }

    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }

    if (body.method === 'tools/call' && body.params.name === 'get_variable_defs') {
      const nodeId = body.params.arguments.nodeId as string;
      const scenario = variableDefsByNode[nodeId];
      requestId += 1;

      if (scenario === 'ERROR') {
        const payload = { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `no such node ${nodeId}` } };
        return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }

      const text = scenario === 'BAD_JSON' ? '{not valid json' : scenario === 'NON_STRING' ? JSON.stringify({ 'Some/Var': 42 }) : JSON.stringify(scenario ?? {});
      const payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } };
      // Alternate response encoding between the two content types this
      // adapter must handle, to exercise both parseMcpResponseBody paths.
      if (requestId % 2 === 0) {
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    throw new Error(`unexpected mock request: ${body.method}`);
  }) as unknown as typeof fetch;
}

describe('createStaticCaptureSource', () => {
  test('returns exactly the capture it was given', async () => {
    const capture = makePreviousCapture();
    const source = createStaticCaptureSource(capture);
    assert.deepEqual(await source.capture(), capture);
  });
});

describe('createFigmaDevModeMcpCaptureSource', () => {
  test('refreshes each known component node\'s variableDefs and preserves everything else unchanged', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({
      '15:664': { 'Paragraph Medium/Line Height': '24' }, // the real, live scenario this adapter is built for
      '18:130': { 'Paragraph Medium/Line Height': '24' },
    });

    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    const refreshed = await source.capture();

    assert.equal(refreshed.components.length, 2);
    assert.equal(refreshed.components[0].figmaNodeId, '15:664');
    assert.deepEqual(refreshed.components[0].variableDefs, { 'Paragraph Medium/Line Height': '24' });
    assert.deepEqual(refreshed.components[1].variableDefs, { 'Paragraph Medium/Line Height': '24' });

    // Structural fields carried over unchanged (never rediscovered).
    assert.equal(refreshed.components[0].name, 'Button');
    assert.equal(refreshed.components[0].width, 844);
    assert.deepEqual(refreshed.components[0].variantSymbols, previousCapture.components[0].variantSymbols);
    assert.deepEqual(refreshed.pagesConfirmedByDirectRead, previousCapture.pagesConfirmedByDirectRead);
    assert.deepEqual(refreshed.sections, previousCapture.sections);
    assert.deepEqual(refreshed.textStyleVariableDefs, previousCapture.textStyleVariableDefs);
    assert.equal(refreshed.fileKey, previousCapture.fileKey);

    // Freshness metadata updated, traceable.
    assert.notEqual(refreshed.capturedAt, previousCapture.capturedAt);
    assert.ok(refreshed.capturedVia.length > previousCapture.capturedVia.length);
  });

  test('fails closed when the server does not return a session id', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({}, { omitSessionId: true });
    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    await assert.rejects(() => source.capture(), FigmaCaptureError);
  });

  test('fails closed when the server is unreachable', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({}, { networkFailure: true });
    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    await assert.rejects(() => source.capture(), FigmaCaptureError);
  });

  test('fails closed on a tool-level JSON-RPC error', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({ '15:664': 'ERROR', '18:130': {} });
    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    await assert.rejects(() => source.capture(), FigmaCaptureError);
  });

  test('fails closed on malformed tool response text', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({ '15:664': 'BAD_JSON', '18:130': {} });
    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    await assert.rejects(() => source.capture(), FigmaCaptureError);
  });

  test('fails closed rather than coercing a non-string variable value', async () => {
    const previousCapture = makePreviousCapture();
    const fetchImpl = makeMockFetch({ '15:664': 'NON_STRING', '18:130': {} });
    const source = createFigmaDevModeMcpCaptureSource({ previousCapture, fetchImpl });
    await assert.rejects(() => source.capture(), FigmaCaptureError);
  });
});
