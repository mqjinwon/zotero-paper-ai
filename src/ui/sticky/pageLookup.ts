/**
 * Shared PDF page element lookup for sticky connectors / visibility.
 */

export function findPageEl(
  doc: Document,
  pageIndex: number,
): HTMLElement | null {
  const pageNum = pageIndex + 1;
  return (
    (doc.querySelector(
      `[data-page-number="${pageNum}"]`,
    ) as HTMLElement | null) ||
    (doc.querySelector(
      `.page[data-page-number="${pageNum}"]`,
    ) as HTMLElement | null) ||
    (doc.querySelectorAll(".page")[pageIndex] as HTMLElement | null) ||
    null
  );
}

/** Prefer PDF.js pageView.div, else data-page-number / .page. */
export function resolvePageElement(
  doc: Document,
  pageIndex: number,
): HTMLElement | null {
  try {
    const win = doc.defaultView as unknown as {
      PDFViewerApplication?: {
        pdfViewer?: {
          getPageView?: (i: number) => { div?: HTMLElement } | undefined;
        };
      };
    } | null;
    const div =
      win?.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex)?.div;
    if (div) return div;
  } catch {
    /* fall through */
  }
  return findPageEl(doc, pageIndex);
}

export function viewerContainerEl(doc: Document): HTMLElement | null {
  return (
    (doc.getElementById("viewerContainer") as HTMLElement | null) ||
    (doc.querySelector("#viewer") as HTMLElement | null)
  );
}

/** Viewer (or window) client rect for intersection tests. */
export function viewerClientRect(doc: Document): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  const container = viewerContainerEl(doc);
  if (container) {
    const cr = container.getBoundingClientRect();
    if (cr.width > 2 && cr.height > 2) {
      return {
        left: cr.left,
        top: cr.top,
        right: cr.right,
        bottom: cr.bottom,
      };
    }
  }
  const w = doc.defaultView?.innerWidth ?? 0;
  const h = doc.defaultView?.innerHeight ?? 0;
  if (w < 2 || h < 2) return null;
  return { left: 0, top: 0, right: w, bottom: h };
}

export function docHasPdfPages(doc: Document): boolean {
  try {
    return !!(
      doc.querySelector?.("[data-page-number]") ||
      doc.querySelector?.(".page") ||
      doc.querySelector?.("#viewer .canvasWrapper canvas") ||
      doc.querySelector?.("#viewerContainer")
    );
  } catch {
    return false;
  }
}

export function sortDocsPdfFirst(docs: Document[]): Document[] {
  return [...docs].sort(
    (a, b) => Number(docHasPdfPages(b)) - Number(docHasPdfPages(a)),
  );
}
