import { createZoteroFileStore } from "./auth/fileStore";
import { resolveFeatureConfig } from "./llm/featureConfig";
import { warmLLM } from "./llm/fastTranslate";
import { PaperAIFactory } from "./modules/paperAI";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  startSelectionUX,
  stopSelectionUX,
} from "./ui/selectionUX";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  PaperAIFactory.registerPrefs();
  PaperAIFactory.registerReaderPane();
  PaperAIFactory.registerReaderIntegration();
  // Custom iframe 「번역/설명」 floating bar is disabled (duplicates official popup).
  startSelectionUX();

  // Prefetch OAuth for translate endpoint (most frequent path)
  void (async () => {
    try {
      await warmLLM(createZoteroFileStore(), resolveFeatureConfig("translate"));
    } catch {
      /* ignore */
    }
  })();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  PaperAIFactory.registerMenus(win);
  startSelectionUX();

  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 4000,
  })
    .createLine({
      text:
        getString("startup-finish") +
        " — PDF 드래그 시 번역 버튼 / 우측 Paper AI 패널",
      type: "success",
      progress: 100,
    })
    .show();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  stopSelectionUX();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  return;
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
