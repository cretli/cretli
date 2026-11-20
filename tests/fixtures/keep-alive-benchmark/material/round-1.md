# Review material: round 1 — account listing

Pull request "Add paginated account listing and owner lookup". Review the diff
below for correctness problems. The code is synthetic (fictional `acme` service).

```diff
--- a/src/accounts/list.js
+++ b/src/accounts/list.js
@@ -1,0 +1,42 @@
+import { db } from '../db.js';
+
+const PAGE_SIZE = 25;
+
+/**
+ * Returns one page of accounts, newest first.
+ * `page` is 1-based, as sent by the UI.
+ */
+export async function listAccounts({ page = 1, orgId }) {
+  const total = await db.count('accounts', { orgId });
+  const pageCount = Math.ceil(total / PAGE_SIZE);
+  const offset = page * PAGE_SIZE;
+  const rows = await db.select('accounts', {
+    where: { orgId },
+    orderBy: 'createdAt DESC',
+    limit: PAGE_SIZE,
+    offset,
+  });
+  return { rows, page, pageCount, total };
+}
+
+/**
+ * Resolves the display name of the person who owns an account.
+ */
+export async function describeOwner(accountId) {
+  const account = await db.get('accounts', accountId);
+  const owner = await db.get('users', account.ownerId);
+  return `${owner.firstName} ${owner.lastName} <${owner.email}>`;
+}
+
+/**
+ * Accounts without an owner are shown as "unassigned" in the UI.
+ */
+export async function listUnassigned(orgId) {
+  const all = await db.select('accounts', { where: { orgId } });
+  return all.filter((account) => account.ownerId == null);
+}
```

Reviewer notes: the page parameter comes straight from the query string, and
`describeOwner` is called for every row of the list in the UI.
