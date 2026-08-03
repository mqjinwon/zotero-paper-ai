/**
 * Reuse ChatGPT/Codex OAuth credentials from ~/.codex/auth.json
 * Port of pdf2zh/auth/codex_oauth.py
 */

import type { FileStore } from "./fileStore";
import { jwtAccountId, jwtExp } from "./jwt";
import {
  cacheKey,
  getCachedToken,
  setCachedToken,
} from "./tokenCache";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  idToken?: string | null;
  raw: Record<string, unknown>;
}

export function defaultCodexAuthPath(store: FileStore): string {
  return store.join(store.homeDir(), ".codex", "auth.json");
}

function resolveAuthPath(store: FileStore, authPath?: string): string {
  const raw = (authPath || "").trim() || defaultCodexAuthPath(store);
  return store.resolvePath ? store.resolvePath(raw) : raw;
}

export async function loadCodexCredentials(
  store: FileStore,
  authPath?: string,
): Promise<CodexCredentials> {
  const path = resolveAuthPath(store, authPath);
  if (!(await store.exists(path))) {
    throw new CodexAuthError(
      `Codex auth file not found at ${path}. Run \`codex login\` first.`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await store.readText(path)) as Record<string, unknown>;
  } catch (e) {
    throw new CodexAuthError(`Invalid Codex auth file ${path}: ${e}`);
  }
  const tokens = (data.tokens || {}) as Record<string, unknown>;
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (!access || !refresh) {
    throw new CodexAuthError(
      `Codex OAuth tokens missing in ${path}. Run \`codex login\` first.`,
    );
  }
  const accountId =
    (tokens.account_id as string | undefined) ||
    jwtAccountId(String(access)) ||
    null;
  return {
    accessToken: String(access),
    refreshToken: String(refresh),
    accountId: accountId ? String(accountId) : null,
    idToken: tokens.id_token ? String(tokens.id_token) : null,
    raw: data,
  };
}

export async function saveCodexCredentials(
  store: FileStore,
  creds: CodexCredentials,
  authPath?: string,
): Promise<void> {
  const path = resolveAuthPath(store, authPath);
  const data = { ...creds.raw };
  const tokens: Record<string, unknown> = {
    ...((data.tokens as Record<string, unknown>) || {}),
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken,
  };
  if (creds.accountId) tokens.account_id = creds.accountId;
  if (creds.idToken) tokens.id_token = creds.idToken;
  data.tokens = tokens;
  data.last_refresh = new Date().toISOString().replace(/\.\d{3}Z$/, ".000000000Z");
  await store.writeText(path, JSON.stringify(data, null, 2));
}

export async function refreshCodexCredentials(
  creds: CodexCredentials,
  opts?: {
    tokenUrl?: string;
    clientId?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<CodexCredentials> {
  const fetchImpl = opts?.fetchImpl || fetch;
  const tokenUrl = opts?.tokenUrl || CODEX_TOKEN_URL;
  const clientId = opts?.clientId || CODEX_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: clientId,
  });
  const resp = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new CodexAuthError(
      `Codex token refresh failed (${resp.status}): ${text.slice(0, 300)}. ` +
        "Run `codex login` again (refresh tokens are single-use).",
    );
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (payload.error) {
    throw new CodexAuthError(
      `Codex token refresh error: ${payload.error}. Run \`codex login\` again.`,
    );
  }
  const access = String(payload.access_token);
  const refresh = String(payload.refresh_token || creds.refreshToken);
  const accountId = jwtAccountId(access) || creds.accountId;
  return {
    accessToken: access,
    refreshToken: refresh,
    accountId,
    idToken: payload.id_token
      ? String(payload.id_token)
      : creds.idToken ?? null,
    raw: creds.raw,
  };
}

export async function getCodexCredentials(
  store: FileStore,
  opts?: {
    authPath?: string;
    minTtl?: number;
    forceRefresh?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<CodexCredentials> {
  const path = resolveAuthPath(store, opts?.authPath);
  const minTtl = opts?.minTtl ?? 90;
  const forceRefresh = opts?.forceRefresh ?? false;
  const key = cacheKey("codex", path);

  if (!forceRefresh) {
    const hit = getCachedToken(key, minTtl);
    if (hit) {
      return {
        accessToken: hit.token,
        refreshToken: "",
        accountId: hit.accountId ?? null,
        raw: {},
      };
    }
  }

  let creds = await loadCodexCredentials(store, path);
  const exp = jwtExp(creds.accessToken);
  const now = Date.now() / 1000;
  if (!forceRefresh && exp !== null && exp - now > minTtl) {
    setCachedToken(key, creds.accessToken, exp, {
      accountId: creds.accountId,
    });
    return creds;
  }
  if (!forceRefresh && exp === null) {
    setCachedToken(key, creds.accessToken, null, {
      accountId: creds.accountId,
    });
    return creds;
  }

  const lockPath = `${path}.lock`;
  return store.withLock(lockPath, async () => {
    const hit2 = getCachedToken(key, minTtl);
    if (!forceRefresh && hit2) {
      return {
        accessToken: hit2.token,
        refreshToken: "",
        accountId: hit2.accountId ?? null,
        raw: {},
      };
    }
    creds = await loadCodexCredentials(store, path);
    const exp2 = jwtExp(creds.accessToken);
    const now2 = Date.now() / 1000;
    if (!forceRefresh && exp2 !== null && exp2 - now2 > minTtl) {
      setCachedToken(key, creds.accessToken, exp2, {
        accountId: creds.accountId,
      });
      return creds;
    }
    const refreshed = await refreshCodexCredentials(creds, {
      fetchImpl: opts?.fetchImpl,
    });
    await saveCodexCredentials(store, refreshed, path);
    setCachedToken(
      key,
      refreshed.accessToken,
      jwtExp(refreshed.accessToken),
      { accountId: refreshed.accountId },
    );
    return refreshed;
  });
}
