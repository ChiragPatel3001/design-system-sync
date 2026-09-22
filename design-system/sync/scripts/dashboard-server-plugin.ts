/**
 * Stage 6F — the smallest possible local API adapter a browser needs to
 * reach the existing sync/agent engines. A Vite dev-server plugin (not a
 * separate process, not a new dependency — `vite` is already a
 * devDependency and already exposes this exact middleware seam), wired
 * into `vite.config.ts` and therefore only ever running under `npm run
 * dev` / `npm run dashboard` — never part of the production `dist/`
 * build (see `configureServer`'s own contract: dev-server only).
 *
 * Three endpoints, all thin pass-throughs to the real engines:
 *   GET  /api/dashboard    -> dashboard-loader.ts's loadDashboardViewModel()
 *   POST /api/agent/run    -> dashboard-agent-handler.ts's handleRunAgentRequest()
 *   POST /api/reconcile    -> dashboard-reconcile-handler.ts's handleReconcileRequest()
 *
 * None of the three endpoints contains policy, targeting, edit, or
 * reconciliation logic itself — see those files' own header comments for
 * where that logic actually lives (agent-policy.ts / agent-targeting.ts /
 * agent-run.ts / reconcile.ts / reconcile-compare.ts, all completely
 * unmodified).
 */
import type { Plugin, ViteDevServer, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadDashboardViewModel } from './dashboard-loader.ts';
import { handleRunAgentRequest, DashboardAgentRequestError } from './dashboard-agent-handler.ts';
import { handleReconcileRequest, createProductionReconcileDeps, ReconcileAlreadyRunningError, DashboardReconcileError } from './dashboard-reconcile-handler.ts';
import {
  createProductionAgentRunDeps,
  createProductionReconciliationInputPaths,
  createProductionReconciliationOutputPaths,
  AGENT_HISTORY_RECORDS_DIR,
  AGENT_HISTORY_LATEST_PATH,
} from './agent-run.ts';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DashboardAgentRequestError('Request body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const handleDashboardGet: Connect.NextHandleFunction = (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  try {
    const viewModel = loadDashboardViewModel({
      reconciliationInputPaths: createProductionReconciliationInputPaths(),
      reconciliationOutputPaths: createProductionReconciliationOutputPaths(),
      agentHistoryPaths: { recordsDir: AGENT_HISTORY_RECORDS_DIR, latestPath: AGENT_HISTORY_LATEST_PATH },
    });
    sendJson(res, 200, viewModel);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
};

const handleAgentRunPost: Connect.NextHandleFunction = (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  readJsonBody(req)
    .then((body) => handleRunAgentRequest(body, createProductionAgentRunDeps()))
    .then((audit) => sendJson(res, 200, audit))
    .catch((err: unknown) => {
      const statusCode = err instanceof DashboardAgentRequestError ? 400 : 500;
      sendJson(res, statusCode, { error: err instanceof Error ? err.message : String(err) });
    });
};

/**
 * The request body is never read — `handleReconcileRequest` takes no
 * arguments at all (see its own header). This endpoint starts exactly
 * one fixed operation; there is nothing for a client to parameterize.
 */
const handleReconcilePost: Connect.NextHandleFunction = (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  handleReconcileRequest(createProductionReconcileDeps())
    .then((summary) => sendJson(res, 200, summary))
    .catch((err: unknown) => {
      const statusCode = err instanceof ReconcileAlreadyRunningError ? 409 : err instanceof DashboardReconcileError ? 502 : 500;
      sendJson(res, statusCode, { error: err instanceof Error ? err.message : String(err) });
    });
};

export function dashboardApiPlugin(): Plugin {
  return {
    name: 'sync-agent-dashboard-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/dashboard', handleDashboardGet);
      server.middlewares.use('/api/agent/run', handleAgentRunPost);
      server.middlewares.use('/api/reconcile', handleReconcilePost);
    },
  };
}
