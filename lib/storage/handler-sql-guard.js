/**
 * Fail-closed SQL guard for the storage handler context (A2 S4, F21; protocol:
 * lib/storage/worker-protocol.md "Handler context").
 *
 * Handlers are trusted in-repo code, but a handler that ends the worker's
 * transaction itself (COMMIT, ROLLBACK, a swallowed auto-rollback followed by
 * an autocommit write) makes a mutation durable without its receipt. The
 * guard turns that footgun into a typed error before SQLite sees the SQL:
 *
 * - transaction control is refused: any `BEGIN`, `COMMIT`, `ROLLBACK`,
 *   `SAVEPOINT` or `RELEASE` token outside literals/comments (which also
 *   refuses `INSERT OR ROLLBACK`, `ON CONFLICT ROLLBACK` and trigger bodies),
 *   and `END` at the start of a statement (`END` inside `CASE … END` is fine);
 * - `prepare` takes exactly one statement (node:sqlite silently ignores the
 *   tail of a multi-statement string); `exec` may run several statements, all
 *   of them are scanned;
 * - executing anything while no transaction is open is refused.
 *
 * The token scan is conservative, not a SQL parser: it can refuse valid SQL
 * that uses one of these keywords as a bare identifier (quote it), and it
 * cannot see a raw connection a handler obtains some other way. Schema DDL
 * with triggers belongs in migrations, which do not run through this guard.
 */
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';

/** Keywords refused anywhere outside literals, comments and parameters. */
const ALWAYS_REFUSED = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
/** Keywords refused only as the first word of a statement. */
const STATEMENT_START_REFUSED = new Set(['END']);
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const PARAM_PREFIX = new Set([':', '@', '$', '?']);
const QUOTE_END = Object.freeze({ "'": "'", '"': '"', '`': '`', '[': ']' });
const MAX_VERIFIED_SQL = 256;

/**
 * @param {string} operation
 * @param {string} message
 * @returns {StorageError}
 */
function refused(operation, message) {
  return new StorageError(STORAGE_ERROR_CODES.IO, message, { retryable: false, details: { operation } });
}

/**
 * Index just after a quoted literal/identifier that starts at `i`. A doubled
 * closing quote is an escape (`'it''s'`); `[...]` has no escape.
 *
 * @param {string} sql
 * @param {number} i
 * @returns {number}
 */
function skipQuoted(sql, i) {
  const close = QUOTE_END[/** @type {keyof typeof QUOTE_END} */ (sql[i])];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] !== close) {
      j += 1;
      continue;
    }
    if (close !== ']' && sql[j + 1] === close) {
      j += 2;
      continue;
    }
    return j + 1;
  }
  return j;
}

/**
 * Index just after a comment starting at `i`, or `i` when there is none.
 *
 * @param {string} sql
 * @param {number} i
 * @returns {number}
 */
function skipComment(sql, i) {
  if (sql[i] === '-' && sql[i + 1] === '-') {
    const end = sql.indexOf('\n', i + 2);
    return end === -1 ? sql.length : end + 1;
  }
  if (sql[i] === '/' && sql[i + 1] === '*') {
    const end = sql.indexOf('*/', i + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return i;
}

/**
 * @param {string} sql
 * @param {number} i
 * @returns {number}
 */
function skipWord(sql, i) {
  let j = i;
  while (j < sql.length && WORD_CHAR.test(sql[j])) j += 1;
  return j;
}

/**
 * Scan `sql` and return the number of non-empty statements. Throws a typed
 * non-retryable `io` (`operation: transaction_control`) on a refused keyword.
 *
 * @param {string} sql
 * @returns {number}
 */
export function scanHandlerSql(sql) {
  if (typeof sql !== 'string') throw refused('sql_invalid', 'Handler SQL must be a string');
  let statements = 0;
  let atStart = true;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const afterComment = skipComment(sql, i);
    if (afterComment !== i) {
      i = afterComment;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === ';') {
      atStart = true;
      i += 1;
    } else if (Object.prototype.hasOwnProperty.call(QUOTE_END, ch)) {
      if (atStart) statements += 1;
      atStart = false;
      i = skipQuoted(sql, i);
    } else if (PARAM_PREFIX.has(ch)) {
      // `:release`, `@end`, `$commit`, `?1` are parameter names, not keywords.
      i = skipWord(sql, i + 1);
      atStart = false;
    } else if (WORD_CHAR.test(ch)) {
      const end = skipWord(sql, i);
      const word = sql.slice(i, end).toUpperCase();
      if (ALWAYS_REFUSED.has(word) || (atStart && STATEMENT_START_REFUSED.has(word))) {
        throw refused('transaction_control', 'Handlers must not issue transaction control statements');
      }
      if (atStart) statements += 1;
      atStart = false;
      i = end;
    } else {
      if (atStart) statements += 1;
      atStart = false;
      i += 1;
    }
  }
  return statements;
}

/**
 * Methods of a node:sqlite StatementSync that step the statement.
 */
const EXECUTING_METHODS = new Set(['run', 'get', 'all', 'iterate']);

/**
 * Build the guarded `{ db, prepare }` pair handed to handlers. `rawDb` is the
 * worker's connection; `prepareRaw` its statement cache. Prepared statements
 * are wrapped once and cached by the caller through `wrapCache`.
 *
 * @param {import('node:sqlite').DatabaseSync} rawDb
 * @param {(sql: string) => import('node:sqlite').StatementSync} prepareRaw
 * @returns {{ db: { exec: (sql: string) => void, prepare: (sql: string) => any, readonly isTransaction: boolean, readonly isOpen: boolean }, prepare: (sql: string) => any }}
 */
export function createGuardedConnection(rawDb, prepareRaw) {
  /** @type {WeakMap<object, any>} */
  const wrapped = new WeakMap();
  /** SQL text that already passed the scan, so hot statements are scanned once. */
  /** @type {Set<string>} */
  const verified = new Set();
  const requireTransaction = () => {
    if (!rawDb.isTransaction) {
      throw refused('no_transaction', 'Handler SQL refused: the request transaction is no longer open');
    }
  };
  /**
   * @param {import('node:sqlite').StatementSync} stmt
   */
  const wrap = (stmt) => {
    let proxy = wrapped.get(stmt);
    if (proxy) return proxy;
    proxy = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (EXECUTING_METHODS.has(/** @type {string} */ (prop))) {
          return (/** @type {unknown[]} */ ...args) => {
            requireTransaction();
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    wrapped.set(stmt, proxy);
    return proxy;
  };
  /**
   * @param {string} sql
   */
  const prepare = (sql) => {
    if (!verified.has(sql)) {
      if (scanHandlerSql(sql) !== 1) throw refused('sql_invalid', 'Handler prepare takes exactly one statement');
      if (verified.size >= MAX_VERIFIED_SQL) verified.delete(verified.values().next().value);
      verified.add(sql);
    }
    requireTransaction();
    return wrap(prepareRaw(sql));
  };
  const db = Object.freeze({
    /**
     * @param {string} sql
     */
    exec(sql) {
      scanHandlerSql(sql);
      requireTransaction();
      rawDb.exec(sql);
    },
    prepare,
    get isTransaction() {
      return rawDb.isTransaction;
    },
    get isOpen() {
      return rawDb.isOpen;
    },
  });
  return { db, prepare };
}
