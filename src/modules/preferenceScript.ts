import { config } from "../../package.json";
import { createZoteroFileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { getOrCreateClient } from "../llm/fastTranslate";
import type { FeatureId } from "../llm/featureConfig";

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
