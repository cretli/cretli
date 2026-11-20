# Review material: round 3 — export with retry

Third pull request "Export accounts with retry and sorted output". Review the
diff below for correctness problems. The code is synthetic (fictional `acme`
service).

```diff
--- a/src/accounts/export.js
+++ b/src/accounts/export.js
@@ -1,0 +1,44 @@
+import { uploadFile } from '../storage.js';
+import { log } from '../log.js';
+
+const MAX_ATTEMPTS = 3;
+
+/**
+ * Uploads with up to three attempts. A failed upload must be reported to the
+ * caller if the last attempt fails too.
+ */
+export async function uploadWithRetry(name, body) {
+  let lastError = null;
+  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
+    try {
+      return await uploadFile(name, body);
+    } catch (error) {
+      lastError = error;
+      log.warn(`upload attempt ${attempt} failed`, error.message);
+    }
+  }
+  log.error('upload gave up', lastError?.message);
+  return null;
+}
+
+/**
+ * Exports accounts as CSV, most recently updated first, and uploads the file.
+ */
+export async function exportAccounts(accounts) {
+  const sorted = [...accounts].sort((a, b) => a.updatedAt - b.updatedAt);
+  const lines = ['id,name,updatedAt'];
+  for (const account of sorted) {
+    lines.push(`${account.id},${account.name},${account.updatedAt}`);
+  }
+  const result = await uploadWithRetry('accounts.csv', lines.join('\n'));
+  return { count: sorted.length, uploaded: result != null };
+}
```

Reviewer notes: the HTTP handler awaits `exportAccounts` and shows the number of
exported accounts.
