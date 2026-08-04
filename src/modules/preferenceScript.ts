import { config } from "../../package.json";
import { createZoteroFileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { getOrCreateClient } from "../llm/fastTranslate";
import type { FeatureId } from "../llm/featureConfig";
import {
  describePaperAiDataDir,
  resolveCustomDataDir,
  resolveZoteroDataDirectory,
} from "../utils/dataDir";

async function testFeature(feature: FeatureId, status: HTMLElement | null) {
  if (status) status.textContent = `Testing ${feature}…`;
  try {
    const cfg = resolveFeatureConfig(feature);
    const store = createZoteroFileStore();
    const client = getOrCreateClient(store, cfg);
    const text = await client.complete({
      model: cfg.model,
      messages: [
        { role: "system", content: "Reply with exactly: ok" },
        { role: "user", content: "ping" },
      ],
      reasoningEffort: cfg.reasoningEffort,
    });
    if (status) {
      const base =
        cfg.provider === "grok" ? cfg.grokBaseUrl : "codex-responses";
      const re = cfg.reasoningEffort || "—";
      status.textContent = `OK [${feature}] ${cfg.provider} | ${cfg.model} | re=${re} | ${base} → ${text.slice(0, 40)}`;
    }
  } catch (e) {
    if (status) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}

function refreshDataDirHint(doc: Document) {
  const el = doc.getElementById(
    `${config.addonRef}-dataDir-resolved`,
  ) as HTMLElement | null;
  if (!el) return;
  try {
    const store = createZoteroFileStore();
    const input = doc.getElementById(
      `zotero-prefpane-${config.addonRef}-dataDir`,
    ) as HTMLInputElement | null;
    const typed = (input?.value ?? "").trim();
    let resolved: string;
    if (typed) {
      resolved = `custom → ${resolveCustomDataDir(store, typed)}`;
    } else if (resolveZoteroDataDirectory()) {
      // Field empty: show default even if pref write lags
      resolved = `Zotero data dir / paperai → ${store.join(resolveZoteroDataDirectory()!, "paperai")}`;
    } else {
      resolved = describePaperAiDataDir(store);
    }
    el.textContent =
      `Resolved RAG root: ${resolved}. Chat/sticky → Zotero item notes (library Sync). ` +
      `RAG only uses this folder. Empty field recommended. ` +
      `OAuth: ~/.grok · ~/.codex. Legacy ~/.paperai still read for old RAG files.`;
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
  }
}

export async function registerPrefsScripts(_window: Window) {
  const doc = _window.document;
  const status = doc.getElementById(
    `${config.addonRef}-test-status`,
  ) as HTMLElement | null;
  const btnTranslate = doc.getElementById(
    `${config.addonRef}-test-connection`,
  ) as HTMLButtonElement | null;
  const btnChat = doc.getElementById(
    `${config.addonRef}-test-chat`,
  ) as HTMLButtonElement | null;

  refreshDataDirHint(doc);
  const dataDirInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-dataDir`,
  ) as HTMLInputElement | null;
  if (dataDirInput) {
    dataDirInput.addEventListener("change", () => refreshDataDirHint(doc));
    dataDirInput.addEventListener("input", () => {
      // Debounce light: only update on idle typing pause via change is enough;
      // still refresh so placeholder edits show quickly.
      refreshDataDirHint(doc);
    });
  }

  if (btnTranslate) {
    if (!btnTranslate.textContent?.trim()) {
      btnTranslate.textContent = "Test translate endpoint";
    }
    btnTranslate.addEventListener("click", () => {
      void testFeature("translate", status);
    });
  }
  if (btnChat) {
    btnChat.addEventListener("click", () => {
      void testFeature("chat", status);
    });
  }
}
