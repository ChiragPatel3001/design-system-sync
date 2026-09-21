# History

Immutable record of every `npm run sync:check` run. One JSON file per run,
named `<timestamp>_<currentSnapshotId>.json` (colons/dots in the timestamp
replaced with `-` for filesystem safety). `check.ts` refuses to overwrite an
existing file here — if a filename collision is ever hit, the run errors out
instead of clobbering the earlier record.

Each file is a `HistoryRecord` (see `../sync/scripts/types.ts`):

```json
{
  "runId": "…",
  "generatedAt": "2026-…",
  "previousSnapshotId": "…",
  "currentSnapshotId": "…",
  "changeCount": 0,
  "changes": []
}
```

`changes` is the exact `ChangeRecord[]` produced by `compareSnapshots()` for
that run — see `../sync/README.md` for the record shape. A run with zero
detected changes still gets a file (`changeCount: 0`, `changes: []`): that's
proof a check happened at that time against that baseline, not just an
absence of evidence.

Both `previousSnapshotId` and `currentSnapshotId` are permanently
resolvable via `../sync/snapshots/archive/<snapshotId>.json`, so a history
record plus the archive together are enough to fully reconstruct what was
being compared, even after `../sync/snapshots/current.json` has since been
overwritten by a later run.

**Do not edit or delete files in this directory by hand.** They're the
audit trail the future sync agent (and any human reviewing it) relies on.
