/**
 * In-memory diagnostic ring buffer for copy/paste debugging (no Zotero reinstall needed).
 */

const MAX = 200;
const lines: string[] = [];

function ts(): string {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

export function diag(scope: string, message: string, detail?: unknown): void {
  let extra = "";
  if (detail !== undefined) {
    try {
      extra =
        typeof detail === "string"
          ? detail
          : JSON.stringify(detail, (_k, v) =>
              typeof v === "bigint" ? String(v) : v,
            ).slice(0, 800);
    } catch {
      extra = String(detail);
    }
  }
  const line = `[${ts()}] [${scope}] ${message}${extra ? " | " + extra : ""}`;
  lines.push(line);
  while (lines.length > MAX) lines.shift();
  try {
    const ztoolkit = (globalThis as any).ztoolkit;
    ztoolkit?.log?.(line);
  } catch {
    /* ignore */
  }
}

export function diagClear(): void {
  lines.length = 0;
}

export function diagSnapshot(): string {
  return lines.join("\n");
}

export function diagLines(): string[] {
  return lines.slice();
}

/** Build a full report for clipboard (includes env snapshot). */
export function buildDiagnosticReport(extra?: Record<string, unknown>): string {
  const Z = (globalThis as any).Zotero;
  const env: Record<string, unknown> = {
    zoteroVersion: Z?.version || null,
    hasReader: !!Z?.Reader,
    readerCount: Z?.Reader?._readers?.length ?? null,
    selectedTab: null as string | null,
    selectedTabType: null as string | null,
    zoteroDataDir: null as string | null,
    paperaiDataDirPref: null as string | null,
    chatStickyStore: "zotero-item-notes (paper-ai-chat / paper-ai-sticky)",
    ragStore: "disk under dataDir/rag",
    ...extra,
  };
  try {
    const win = Z?.getMainWindow?.() || globalThis;
    const tabs = win?.Zotero_Tabs;
    env.selectedTab = tabs?.selectedID ?? null;
    env.selectedTabType = tabs?.selectedType ?? null;
  } catch {
    /* ignore */
  }
  try {
    env.zoteroDataDir =
      Z?.DataDirectory?.dir || Z?.DataDirectory?.defaultDir || null;
  } catch {
    /* ignore */
  }
  try {
    env.paperaiDataDirPref =
      Z?.Prefs?.get?.("extensions.zotero.paperai.dataDir", true) ?? null;
  } catch {
    /* ignore */
  }

  return [
    "=== Paper AI diagnostic report ===",
    `generated: ${ts()}`,
    "--- env ---",
    JSON.stringify(env, null, 2),
    "--- log ---",
    lines.length ? lines.join("\n") : "(empty)",
    "=== end ===",
  ].join("\n");
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const g = globalThis as any;
    if (g.navigator?.clipboard?.writeText) {
      await g.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const g = globalThis as any;
    const Cc = g.Cc || g.Components?.classes;
    const Ci = g.Ci || g.Components?.interfaces;
    if (Cc && Ci) {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper,
      );
      helper.copyString(text);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
