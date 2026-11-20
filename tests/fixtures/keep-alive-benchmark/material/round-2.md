# Review material: round 2 — account updates and cache

Follow-up pull request "Cache account lookups and add rename". Review the diff
below for correctness problems. The code is synthetic (fictional `acme` service).

```diff
--- a/src/accounts/cache.js
+++ b/src/accounts/cache.js
@@ -1,0 +1,38 @@
+import { db } from '../db.js';
+
+const cache = new Map();
+const TTL_MS = 5 * 60 * 1000;
+
+/**
+ * Cached read of one account. Entries live for five minutes.
+ */
+export async function getAccountCached(id) {
+  const hit = cache.get(id);
+  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
+  const value = await db.get('accounts', id);
+  cache.set(id, { value, at: Date.now() });
+  return value;
+}
+
+/**
+ * Renames an account and records who did it in the audit log.
+ */
+export async function renameAccount(id, name, actorId) {
+  const account = await getAccountCached(id);
+  if (!account) throw new Error(`Unknown account ${id}`);
+  await db.update('accounts', id, { name, updatedAt: Date.now() });
+  db.insert('audit', {
+    at: Date.now(),
+    actorId,
+    action: 'account.rename',
+    accountId: id,
+    from: account.name,
+    to: name,
+  });
+  return { id, name };
+}
+
+export function clearAccountCache() {
+  cache.clear();
+}
```

Reviewer notes: `renameAccount` is called from the HTTP handler and its result
is returned to the UI immediately; the next list request reads accounts through
`getAccountCached`.
