import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { mountPanel, triggerMode } from "../ui/panel";
import { registerReaderEvents } from "../ui/readerEvents";

export class PaperAIFactory {
  static registerPrefs() {
    Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: getString("prefs-title"),
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    });
  }

  static registerReaderPane() {
    const icon16 = rootURI + "content/icons/favicon@0.5x.png";
    const icon20 = rootURI + "content/icons/favicon.png";

    const key = Zotero.ItemPaneManager.registerSection({
      paneID: `${config.addonRef}-reader-section`,
      pluginID: config.addonID,
      header: {
        l10nID: getLocaleID("item-section-s1-head-text"),
        icon: icon16,
      },
      sidenav: {
        l10nID: getLocaleID("item-section-s1-sidenav-tooltip"),
        icon: icon20,
      },
      // Show for both library + reader so the sidenav icon always exists
      onItemChange: ({ setEnabled }) => {
        setEnabled(true);
        return true;
      },
      onRender: ({ body, tabType }) => {
        try {
          body.replaceChildren();
        } catch {
          try {
            (body as HTMLElement).innerHTML = "";
          } catch {
            /* ignore */
          }
        }
        const doc = body.ownerDocument;
        if (!doc) return;

        // Item pane body must be able to expand and scroll.
        try {
          const el = body as HTMLElement;
          el.style.pointerEvents = "auto";
          el.style.overflow = "auto";
          el.style.minHeight = "420px";
          el.style.display = "block";
        } catch {
          /* ignore */
        }

        // Prefer full panel whenever a reader tab is selected; also fall back
        // if tabType is missing/unexpected but a reader instance exists.
        let isReader = tabType === "reader";
        if (!isReader) {
          try {
            const tabs = (globalThis as any).Zotero_Tabs;

            const reader = Zotero.Reader?.getByTabID?.(tabs?.selectedID);
            isReader = !!reader;
          } catch {
            isReader = false;
          }
        }

        if (!isReader) {
          const tip = doc.createElement("div");
          tip.setAttribute(
            "style",
            "padding:12px;font:13px/1.5 system-ui;color:#1a1a1a;background:#f7f7f8;border-radius:10px;pointer-events:auto;min-height:120px",
          );
          tip.innerHTML =
            "<b>Paper AI</b><br/><br/>" +
            "① PDF를 <b>Zotero 안에서</b> 엽니다 (라이브러리 탭이 아님).<br/>" +
            "② 문장 드래그 → <b>번역 / 설명</b><br/>" +
            "③ 그림은 이 패널의 <b>그림/표 설명</b><br/>" +
            "④ 질문은 입력 후 <b>Enter</b> 또는 <b>보내기</b>";
          body.appendChild(tip);
          return;
        }

        const wrap = doc.createElement("div");
        wrap.setAttribute(
          "style",
          "display:block;min-height:420px;height:100%;pointer-events:auto;position:relative;z-index:1;overflow:auto",
        );
        body.appendChild(wrap);
        try {
          mountPanel(doc, wrap);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          wrap.textContent = `Paper AI mount error: ${msg}`;
          try {
            ztoolkit.log("Paper AI mountPanel error", e);
          } catch {
            /* ignore */
          }
        }
      },
    });
    ztoolkit.log("Paper AI section registered:", key);
  }

  static registerReaderIntegration() {
    registerReaderEvents();
  }

  static registerMenus(_win: _ZoteroTypes.MainWindow) {
    ztoolkit.Menu.register("menuTools", {
      tag: "menu",
      id: `${config.addonRef}-tools-menu`,
      label: config.addonName,
      children: [
        {
          tag: "menuitem",
          label: "선택 구간 번역",
          commandListener: () => void triggerMode("translate"),
        },
        {
          tag: "menuitem",
          label: "선택 구간 설명",
          commandListener: () => void triggerMode("explain"),
        },
        {
          tag: "menuitem",
          label: "영역 그림 설명 (PDF 툴바 또는 Select Area 주석)",
          commandListener: () => {
            new ztoolkit.ProgressWindow(config.addonName)
              .createLine({
                text: "PDF 툴바「영역 그림 설명」또는 Select Area 주석 우클릭 → Paper AI 그림 설명",
                type: "default",
                progress: 100,
              })
              .show();
          },
        },
      ],
    });
  }
}
