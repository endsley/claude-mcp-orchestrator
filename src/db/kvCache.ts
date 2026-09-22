import type { Db } from './database.js';
import type { JsonValue } from '../types/json.js';

/**
 * Namespaced, TTL'd cache backed by SQLite.
 *
 * Persisting caches means a service restart does not cost a cold Tailscale call
 * or a full project rescan on the first voice turn — which is exactly the turn
 * a user is most likely to be waiting on.
 */
export class KvCache {
  constructor(private readonly db: Db) {}

  get<T extends JsonValue = JsonValue>(namespace: string, key: string, now = new Date()): T | undefined {
    const row = this.db
      .prepare('SELECT value_json, expires_at FROM kv_cache WHERE namespace = ? AND key = ?')
      .get(namespace, key) as { value_json: string; expires_at: string | null } | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()) {
      this.delete(namespace, key);
      return undefined;
    }
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      // A corrupt row is a cache miss, never a crash.
      this.delete(namespace, key);
      return undefined;
    }
  }

  set(namespace: string, key: string, value: JsonValue, ttlMs?: number, now = new Date()): void {
    const expiresAt = ttlMs !== undefined && ttlMs > 0 ? new Date(now.getTime() + ttlMs).toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO kv_cache (namespace, key, value_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, key, JSON.stringify(value), expiresAt, now.toISOString());
  }

  delete(namespace: string, key: string): void {
    this.db.prepare('DELETE FROM kv_cache WHERE namespace = ? AND key = ?').run(namespace, key);
  }

  clearNamespace(namespace: string): void {
    this.db.prepare('DELETE FROM kv_cache WHERE namespace = ?').run(namespace);
  }

  /**
   * Drop expired rows. Safe to call concurrently.
   *
   * Called once at startup (app.ts) and nowhere else - the comment used to
   * claim it ran periodically, which was never true. It does not matter
   * today: nothing in src/ calls get() or set(), so kv_cache is never
   * written and cannot grow. If a consumer is ever added, this needs a timer
   * like the OAuth store's.
   */
  pruneExpired(now = new Date()): number {
    const result = this.db
      .prepare('DELETE FROM kv_cache WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(now.toISOString());
    return result.changes;
  }
}
