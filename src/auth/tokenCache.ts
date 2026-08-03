/**
 * In-memory access-token cache to avoid reading/refreshing auth.json
 * on every translate keystroke / selection.
 */

interface CacheEntry {
  token: string;
  /** unix seconds; null = unknown, treat as short-lived */
  expiresAt: number | null;
  accountId?: string | null;
}

const cache = new Map<string, CacheEntry>();

export function cacheKey(provider: string, pathOrApi: string): string {
  return `${provider}::${pathOrApi || "default"}`;
}

export function getCachedToken(
  key: string,
  minTtl = 120,
): CacheEntry | null {
  const e = cache.get(key);
  if (!e?.token) return null;
  if (e.expiresAt == null) return e;
  if (e.expiresAt - Date.now() / 1000 > minTtl) return e;
  return null;
}

export function setCachedToken(
  key: string,
  token: string,
  expiresAt: number | null,
  extra?: { accountId?: string | null },
): void {
  cache.set(key, {
    token,
    expiresAt,
    accountId: extra?.accountId,
  });
}

export function clearTokenCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
