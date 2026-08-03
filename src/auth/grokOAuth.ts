/**
 * Reuse Grok Build OIDC credentials from ~/.grok/auth.json
 * Port of pdf2zh/auth/grok_oauth.py
 */

import type { FileStore } from "./fileStore";
import { cacheKey, getCachedToken, setCachedToken } from "./tokenCache";

export const DEFAULT_OIDC_ISSUER = "https://auth.x.ai";
export const DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";

export class GrokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokAuthError";
  }
}

export interface GrokCredentials {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  issuer: string;
  entryKey: string;
  expiresAt: number | null;
  raw: Record<string, unknown>;
  entry: Record<string, unknown>;
}

export function defaultGrokAuthPath(store: FileStore): string {
  return store.join(store.homeDir(), ".grok", "auth.json");
}

function parseExpiresAt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    let s = value.trim();
    if (!s) return null;
    if (s.endsWith("Z")) s = s.slice(0, -1) + "+00:00";
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t / 1000;
  }
  return null;
}

function formatExpiresAt(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveAuthPath(store: FileStore, authPath?: string): string {
  const raw = (authPath || "").trim() || defaultGrokAuthPath(store);
  return store.resolvePath ? store.resolvePath(raw) : raw;
}

export async function loadGrokCredentials(
  store: FileStore,
  authPath?: string,
): Promise<GrokCredentials> {
  const path = resolveAuthPath(store, authPath);
  if (!(await store.exists(path))) {
    throw new GrokAuthError(
      `Grok auth file not found at ${path}. Run \`grok login\` first.`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await store.readText(path)) as Record<string, unknown>;
  } catch (e) {
    throw new GrokAuthError(`Invalid Grok auth file ${path}: ${e}`);
  }
  if (!data || typeof data !== "object" || !Object.keys(data).length) {
    throw new GrokAuthError(
      `Grok auth file ${path} has no sessions. Run \`grok login\`.`,
    );
  }

  let entryKey: string | null = null;
  let entry: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (e.key && e.refresh_token) {
      entryKey = k;
      entry = e;
      if (e.auth_mode === "oidc" || String(k).includes("auth.x.ai")) break;
    }
  }
  if (!entry || !entryKey) {
    throw new GrokAuthError(
      `No usable Grok OIDC session in ${path}. Run \`grok login\` first.`,
    );
  }
  const access = entry.key;
  const refresh = entry.refresh_token;
  const clientId = entry.oidc_client_id;
  const issuer = (entry.oidc_issuer as string) || DEFAULT_OIDC_ISSUER;
  if (!access || !refresh || !clientId) {
    throw new GrokAuthError(
      `Incomplete Grok OIDC credentials in ${path}. Run \`grok login\`.`,
    );
  }
  return {
    accessToken: String(access),
    refreshToken: String(refresh),
    clientId: String(clientId),
    issuer: String(issuer),
    entryKey,
    expiresAt: parseExpiresAt(entry.expires_at),
    raw: data,
    entry: { ...entry },
  };
}

export async function saveGrokCredentials(
  store: FileStore,
  creds: GrokCredentials,
  authPath?: string,
): Promise<void> {
  const path = resolveAuthPath(store, authPath);
  const data = { ...creds.raw };
  const entry: Record<string, unknown> = {
    ...creds.entry,
    key: creds.accessToken,
    refresh_token: creds.refreshToken,
  };
  if (creds.expiresAt != null) {
    entry.expires_at = formatExpiresAt(creds.expiresAt);
  }
  data[creds.entryKey] = entry;
  await store.writeText(path, JSON.stringify(data, null, 2));
}

export async function resolveTokenUrl(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const discovery = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  try {
    const resp = await fetchImpl(discovery);
    if (resp.ok) {
      const json = (await resp.json()) as { token_endpoint?: string };
      if (json.token_endpoint) return json.token_endpoint;
    }
  } catch {
    /* fall through */
  }
  if (issuer.replace(/\/$/, "") === DEFAULT_OIDC_ISSUER) {
    return DEFAULT_TOKEN_URL;
  }
  return `${issuer.replace(/\/$/, "")}/oauth2/token`;
}

export async function refreshGrokCredentials(
  creds: GrokCredentials,
  opts?: { fetchImpl?: typeof fetch; tokenUrl?: string },
): Promise<GrokCredentials> {
  const fetchImpl = opts?.fetchImpl || fetch;
  const url =
    opts?.tokenUrl || (await resolveTokenUrl(creds.issuer, fetchImpl));
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
  });
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "paperai-grok-oauth/1.0",
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new GrokAuthError(
      `Grok token refresh failed (${resp.status}): ${text.slice(0, 300)}. ` +
        "Run `grok login` again.",
    );
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (payload.error && !payload.access_token) {
    throw new GrokAuthError(
      `Grok token refresh error: ${payload.error}. Run \`grok login\`.`,
    );
  }
  const access = String(payload.access_token);
  const refresh = String(payload.refresh_token || creds.refreshToken);
  const expiresIn = Number(payload.expires_in || 21600);
  return {
    ...creds,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() / 1000 + expiresIn,
  };
}

export async function getGrokAccessToken(
  store: FileStore,
  opts?: {
    authPath?: string;
    minTtl?: number;
    forceRefresh?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<string> {
  const path = resolveAuthPath(store, opts?.authPath);
  const minTtl = opts?.minTtl ?? 90;
  const forceRefresh = opts?.forceRefresh ?? false;
  const key = cacheKey("grok", path);

  if (!forceRefresh) {
    const hit = getCachedToken(key, minTtl);
    if (hit) return hit.token;
  }

  let creds = await loadGrokCredentials(store, path);
  const now = Date.now() / 1000;
  const fresh = creds.expiresAt === null || creds.expiresAt - now > minTtl;
  if (!forceRefresh && fresh) {
    setCachedToken(key, creds.accessToken, creds.expiresAt);
    return creds.accessToken;
  }

  const lockPath = `${path}.lock`;
  return store.withLock(lockPath, async () => {
    // Another request may have refreshed while we waited.
    const hit2 = getCachedToken(key, minTtl);
    if (!forceRefresh && hit2) return hit2.token;

    creds = await loadGrokCredentials(store, path);
    const now2 = Date.now() / 1000;
    const fresh2 = creds.expiresAt === null || creds.expiresAt - now2 > minTtl;
    if (!forceRefresh && fresh2) {
      setCachedToken(key, creds.accessToken, creds.expiresAt);
      return creds.accessToken;
    }
    const refreshed = await refreshGrokCredentials(creds, {
      fetchImpl: opts?.fetchImpl,
    });
    await saveGrokCredentials(store, refreshed, path);
    setCachedToken(key, refreshed.accessToken, refreshed.expiresAt);
    return refreshed.accessToken;
  });
}
