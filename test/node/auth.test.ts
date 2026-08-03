import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  getCodexCredentials,
  getGrokAccessToken,
  loadCodexCredentials,
  loadGrokCredentials,
  type FileStore,
} from "../../src/auth/index.ts";
import { createNodeFileStore } from "../../src/auth/nodeFileStore.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fakeJwt(exp: number, accountId = "acct_1"): string {
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  return `${header}.${payload}.sig`;
}

describe("Codex OAuth", () => {
  let dir: string;
  let store: FileStore;
  let authPath: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paperai-codex-"));
    store = await createNodeFileStore();
    authPath = path.join(dir, "auth.json");
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads credentials from auth.json", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: fakeJwt(exp),
          refresh_token: "refresh-1",
          account_id: "acct_1",
        },
      }),
      "utf-8",
    );
    const creds = await loadCodexCredentials(store, authPath);
    assert.equal(creds.refreshToken, "refresh-1");
    assert.equal(creds.accountId, "acct_1");
  });

  it("refreshes when near expiry and writes back", async () => {
    const exp = Math.floor(Date.now() / 1000) + 10; // < minTtl 60
    await writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: fakeJwt(exp, "acct_old"),
          refresh_token: "refresh-old",
        },
      }),
      "utf-8",
    );

    const newExp = Math.floor(Date.now() / 1000) + 7200;
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          access_token: fakeJwt(newExp, "acct_new"),
          refresh_token: "refresh-new",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const creds = await getCodexCredentials(store, {
      authPath,
      minTtl: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(creds.refreshToken, "refresh-new");
    assert.equal(creds.accountId, "acct_new");
    const saved = JSON.parse(await readFile(authPath, "utf-8"));
    assert.equal(saved.tokens.refresh_token, "refresh-new");
  });
});

describe("Grok OAuth", () => {
  let dir: string;
  let store: FileStore;
  let authPath: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paperai-grok-"));
    store = await createNodeFileStore();
    authPath = path.join(dir, "auth.json");
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads OIDC session", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::test": {
          key: "access-abc",
          refresh_token: "refresh-abc",
          oidc_client_id: "client-1",
          oidc_issuer: "https://auth.x.ai",
          auth_mode: "oidc",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
      "utf-8",
    );
    const creds = await loadGrokCredentials(store, authPath);
    assert.equal(creds.accessToken, "access-abc");
    assert.equal(creds.clientId, "client-1");
  });

  it("refreshes expired token", async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::test": {
          key: "access-old",
          refresh_token: "refresh-old",
          oidc_client_id: "client-1",
          oidc_issuer: "https://auth.x.ai",
          auth_mode: "oidc",
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      }),
      "utf-8",
    );

    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      if (u.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({ token_endpoint: "https://auth.x.ai/oauth2/token" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };

    const token = await getGrokAccessToken(store, {
      authPath,
      minTtl: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(token, "access-new");
    const saved = JSON.parse(await readFile(authPath, "utf-8"));
    assert.equal(saved["https://auth.x.ai::test"].key, "access-new");
  });
});

describe("defaults", () => {
  it("resolves home auth paths", async () => {
    const store = await createNodeFileStore();
    const codex = store.join(store.homeDir(), ".codex", "auth.json");
    const grok = store.join(store.homeDir(), ".grok", "auth.json");
    assert.ok(codex.endsWith(path.join(".codex", "auth.json")));
    assert.ok(grok.endsWith(path.join(".grok", "auth.json")));
    // silence unused
    await mkdir(path.dirname(codex), { recursive: true }).catch(
      () => undefined,
    );
  });

  it("expands ~ in resolvePath", async () => {
    const store = await createNodeFileStore();
    const expanded = store.resolvePath("~/.grok/auth.json");
    assert.equal(expanded, path.join(store.homeDir(), ".grok", "auth.json"));
  });
});
