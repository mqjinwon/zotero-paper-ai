/**
 * Live smoke: load real ~/.codex and ~/.grok credentials (no token print).
 * Optionally call providers with a tiny prompt if SMOKE_LIVE=1.
 */
import { createNodeFileStore } from "../src/auth/nodeFileStore.ts";
import {
  getCodexCredentials,
  loadCodexCredentials,
  defaultCodexAuthPath,
} from "../src/auth/codexOAuth.ts";
import {
  getGrokAccessToken,
  loadGrokCredentials,
  defaultGrokAuthPath,
} from "../src/auth/grokOAuth.ts";
import { GrokClient } from "../src/llm/grokClient.ts";
import { CodexClient } from "../src/llm/codexClient.ts";

async function main() {
  const store = await createNodeFileStore();
  const codexPath = defaultCodexAuthPath(store);
  const grokPath = defaultGrokAuthPath(store);

  console.log("home:", store.homeDir());
  console.log("codex path exists:", await store.exists(codexPath));
  console.log("grok path exists:", await store.exists(grokPath));

  if (await store.exists(codexPath)) {
    const c = await loadCodexCredentials(store, codexPath);
    console.log(
      "codex: access len",
      c.accessToken.length,
      "account",
      !!c.accountId,
    );
    try {
      const refreshed = await getCodexCredentials(store, { minTtl: 60 });
      console.log(
        "codex: get credentials ok, access len",
        refreshed.accessToken.length,
      );
    } catch (e) {
      console.log(
        "codex: get credentials:",
        (e as Error).message.slice(0, 200),
      );
    }
  }

  if (await store.exists(grokPath)) {
    const g = await loadGrokCredentials(store, grokPath);
    console.log(
      "grok: access len",
      g.accessToken.length,
      "expires",
      g.expiresAt ? new Date(g.expiresAt * 1000).toISOString() : null,
    );
    try {
      const token = await getGrokAccessToken(store, { minTtl: 60 });
      console.log("grok: get token ok, len", token.length);
    } catch (e) {
      console.log("grok: get token:", (e as Error).message.slice(0, 200));
    }
  }

  if (process.env.SMOKE_LIVE === "1") {
    console.log("--- live completions ---");
    if (await store.exists(grokPath)) {
      try {
        const client = new GrokClient({ store });
        const out = await client.complete({
          messages: [
            { role: "system", content: "Reply with exactly: pong" },
            { role: "user", content: "ping" },
          ],
        });
        console.log("grok live:", out.slice(0, 120));
      } catch (e) {
        console.log("grok live fail:", (e as Error).message.slice(0, 300));
      }
    }
    if (await store.exists(codexPath)) {
      try {
        const client = new CodexClient({ store });
        const out = await client.complete({
          messages: [
            { role: "system", content: "Reply with exactly: pong" },
            { role: "user", content: "ping" },
          ],
        });
        console.log("codex live:", out.slice(0, 120));
      } catch (e) {
        console.log("codex live fail:", (e as Error).message.slice(0, 300));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
