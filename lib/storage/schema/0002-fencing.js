/**
 * Core schema v2: fencing high-water mark mirror (A2 S6).
 *
 * `storage_fencing` is a singleton row holding the highest owner epoch the
 * store has ever accepted a write for. The authoritative HWM also lives in the
 * storage control directory (lib/storage/coordinator.md); the worker compares
 * a write's `fenceEpoch` with this row inside the write transaction and raises
 * it when a newer owner commits, so a zombie owner that survived a takeover
 * cannot commit even if it still holds an open connection.
 */
export default Object.freeze({
  version: 2,
  name: 'fencing',
  sql: `
CREATE TABLE storage_fencing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hwm INTEGER NOT NULL CHECK (hwm >= 0)
) STRICT;

INSERT INTO storage_fencing (id, hwm) VALUES (1, 0);
`,
});
