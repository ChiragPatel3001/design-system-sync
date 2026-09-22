/**
 * The dashboard's "Run Reconcile" action — the server-side orchestration
 * behind `POST /api/reconcile`. This is NOT a second reconciliation
 * engine: every step below calls an existing, unmodified function —
 *
 *   refreshCodeSnapshot()          <- code-check.ts, unmodified (the exact
 *                                      function `npm run sync:code-check` uses)
 *   attemptAutomaticFigmaRefresh() <- reconcile.ts, unmodified (the exact
 *                                      function `npm run sync:reconcile` uses)
 *   loadReconciliationInputs()     <- reconcile.ts, unmodified
 *   reconcileSnapshots()           <- reconcile-compare.ts, unmodified (Stage 5C)
 *   buildReconciliationRun()       <- reconcile.ts, unmodified
 *   persistReconciliationRun()     <- reconcile.ts, unmodified
 *
 * This file adds three things none of those functions has on its own:
 * (1) an in-process concurrency guard, since the dashboard is a
 * long-running server a browser can click twice; (2) a single
 * structured result/error shape an HTTP handler can serialize; and (3)
 * an injectable `DashboardReconcileDeps` seam — mirroring
 * agent-run.ts's `AgentRunDeps`/`createProductionAgentRunDeps()` — so
 * this is testable against isolated fixtures without ever touching the
 * real repository. `createProductionReconcileDeps()` is what the real
 * dashboard server actually uses.
 *
 * Takes no request input at all — see dashboard-server-plugin.ts's
 * `handleReconcilePost`, which never reads anything from the request
 * body before calling this. There is nothing for a browser to control
 * here beyond "start one run" — no file path, no reconciliation id, no
 * command string.
 */
import { refreshCodeSnapshot, CodeCheckError } from './code-check.ts';
import {
  attemptAutomaticFigmaRefresh,
  loadReconciliationInputs,
  buildReconciliationRun,
  persistReconciliationRun,
  ReconcileError,
  type ReconcileInputPaths,
  type ReconciliationOutputPaths,
} from './reconcile.ts';
import { reconcileSnapshots } from './reconcile-compare.ts';
import { createProductionReconciliationInputPaths, createProductionReconciliationOutputPaths } from './agent-run.ts';
import type { ReconciliationRun } from './reconcile-types.ts';

export class DashboardReconcileError extends Error {}
export class ReconcileAlreadyRunningError extends DashboardReconcileError {}

export interface ReconcileRunSummary {
  run: ReconciliationRun;
  codeSnapshotId: string;
  codeChangeCount: number;
  figmaRefreshed: boolean;
  figmaSnapshotId: string;
}

export interface DashboardReconcileDeps {
  refreshCode: () => { snapshotId: string; changeCount: number };
  refreshFigma: () => Promise<{ ok: true; snapshotId: string | null } | { ok: false; message: string }>;
  reconciliationInputPaths: ReconcileInputPaths;
  reconciliationOutputPaths: ReconciliationOutputPaths;
}

/** The real, production wiring — the exact same functions/paths `npm run sync:code-check` and `npm run sync:reconcile` use. */
export function createProductionReconcileDeps(): DashboardReconcileDeps {
  return {
    refreshCode: () => {
      const result = refreshCodeSnapshot();
      return { snapshotId: result.current.snapshotId, changeCount: result.changes.length };
    },
    refreshFigma: attemptAutomaticFigmaRefresh,
    reconciliationInputPaths: createProductionReconciliationInputPaths(),
    reconciliationOutputPaths: createProductionReconciliationOutputPaths(),
  };
}

// Module-level lock — this is a single long-running dev-server process
// (see dashboard-server-plugin.ts's own header on why that's the right
// model here), so a plain in-memory flag is sufficient and correct; it
// deliberately is NOT a queue or a retry mechanism — a second click while
// a run is in flight is refused, not queued.
let runInFlight = false;

export function isReconcileRunInFlight(): boolean {
  return runInFlight;
}

export async function handleReconcileRequest(deps: DashboardReconcileDeps): Promise<ReconcileRunSummary> {
  if (runInFlight) {
    throw new ReconcileAlreadyRunningError('A reconciliation run is already in progress. Wait for it to finish before starting another.');
  }

  runInFlight = true;
  try {
    let codeResult: { snapshotId: string; changeCount: number };
    try {
      codeResult = deps.refreshCode();
    } catch (err) {
      throw new DashboardReconcileError(`Code snapshot refresh failed: ${err instanceof CodeCheckError || err instanceof Error ? err.message : String(err)}`);
    }

    const figmaRefresh = await deps.refreshFigma();
    if (!figmaRefresh.ok) {
      throw new DashboardReconcileError(
        `Figma capture refresh failed: ${figmaRefresh.message} Set FIGMA_SKIP_AUTO_REFRESH=1 (and restart the dashboard) to reconcile against the last cached Figma capture instead.`,
      );
    }

    let input;
    try {
      input = loadReconciliationInputs(deps.reconciliationInputPaths);
    } catch (err) {
      throw new DashboardReconcileError(`Could not load reconciliation inputs: ${err instanceof ReconcileError || err instanceof Error ? err.message : String(err)}`);
    }

    // reconcileSnapshots() is Stage 5C's pure, unmodified function — this
    // handler makes no comparison/semantic decisions of its own.
    const records = reconcileSnapshots(input);
    const run = buildReconciliationRun(input, records, new Date().toISOString());

    try {
      persistReconciliationRun(run, deps.reconciliationOutputPaths);
    } catch (err) {
      throw new DashboardReconcileError(`Could not persist the reconciliation run: ${err instanceof ReconcileError || err instanceof Error ? err.message : String(err)}`);
    }

    return {
      run,
      codeSnapshotId: codeResult.snapshotId,
      codeChangeCount: codeResult.changeCount,
      figmaRefreshed: figmaRefresh.snapshotId !== null,
      figmaSnapshotId: input.figmaCurrent.snapshotId,
    };
  } finally {
    runInFlight = false;
  }
}
