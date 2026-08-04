/**
 * Minimal filesystem abstraction for OAuth credential files.
 */

/** True for absolute Unix/Windows paths PathUtils will accept. */
export function isAbsoluteFsPath(p: string): boolean {
  if (!p) return false;
  const s = p.trim();
  if (s.startsWith("/") || s.startsWith("\\\\")) return true;
  // C:\ or C:/
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  return false;
}

export interface FileStore {
  homeDir(): string;
  join(...parts: string[]): string;
  /** Expand ~ and relative paths to absolute (PathUtils requires absolute). */
  resolvePath(path: string): string;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T>;
  /** Basename entries in a directory (empty if missing). Optional for older stores. */
  listDir?(path: string): Promise<string[]>;
}

export async function softFileLock<T>(
  lockPath: string,
  writeLock: (p: string) => Promise<void>,
  removeLock: (p: string) => Promise<void>,
  exists: (p: string) => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (!(await exists(lockPath))) {
      try {
        await writeLock(lockPath);
        break;
      } catch {
        /* race */
      }
    }
    await sleep(40);
  }
  try {
    return await fn();
  } finally {
    try {
      await removeLock(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve OS home directory in Zotero / Firefox chrome (Zotero 7–9).
 * PathUtils.homeDir is NOT available on Zotero 9's PathUtils typings/runtime.
 */
export function resolveZoteroHomeDir(): string {
  const g = globalThis as any;

  const pathUtils = g.PathUtils;
  if (pathUtils) {
    if (typeof pathUtils.homeDir === "string" && pathUtils.homeDir) {
      return pathUtils.homeDir;
    }
    if (typeof pathUtils.getHomeDir === "function") {
      try {
        const h = pathUtils.getHomeDir();
        if (h) return String(h);
      } catch {
        /* continue */
      }
    }
  }

  // Services.dirsvc (Firefox / Zotero chrome)
  try {
    const Services =
      g.Services ||
      g.ChromeUtils?.importESModule?.("resource://gre/modules/Services.sys.mjs")
        ?.Services;
    const Ci = g.Ci || g.Components?.interfaces;
    if (Services?.dirsvc && Ci?.nsIFile) {
      const f = Services.dirsvc.get("Home", Ci.nsIFile);
      if (f?.path) return String(f.path);
    }
  } catch {
    /* continue */
  }

  // Legacy XPCOM directory service
  try {
    const Cc = g.Components?.classes || g.Cc;
    const Ci = g.Components?.interfaces || g.Ci;
    if (Cc && Ci) {
      const f = Cc["@mozilla.org/file/directory_service;1"]
        .getService(Ci.nsIProperties)
        .get("Home", Ci.nsIFile);
      if (f?.path) return String(f.path);
    }
  } catch {
    /* continue */
  }

  // Zotero helpers (some builds)
  try {
    if (typeof g.Zotero?.getHomeDirectory === "function") {
      const h = g.Zotero.getHomeDirectory();
      if (h) return String(h);
    }
    // Data directory is often ~/Zotero → parent is home
    const dataDir =
      g.Zotero?.DataDirectory?.dir ||
      g.Zotero?.DataDirectory?.defaultDir ||
      pathUtils?.profileDir;
    if (typeof dataDir === "string" && dataDir.includes("/")) {
      // e.g. /home/jin/Zotero → /home/jin
      const parts = dataDir.replace(/\\/g, "/").split("/");
      if (parts.length >= 3 && parts[1] === "home") {
        return `/${parts[1]}/${parts[2]}`;
      }
      // Windows-ish: C:\Users\name\Zotero
      if (parts.length >= 3 && /users/i.test(parts[1] || parts[0] || "")) {
        const idx = parts.findIndex((p: string) => /users/i.test(p));
        if (idx >= 0 && parts[idx + 1]) {
          return parts
            .slice(0, idx + 2)
            .join(dataDir.includes("\\") ? "\\" : "/");
        }
      }
    }
  } catch {
    /* continue */
  }

  // Environment (rare in chrome, but cheap)
  try {
    const env = g.Services?.env;
    if (env?.get) {
      const h = env.get("HOME") || env.get("USERPROFILE");
      if (h) return String(h);
    }
  } catch {
    /* continue */
  }

  throw new Error(
    "Cannot resolve home directory. Leave auth paths empty or set absolute paths " +
      "(e.g. /home/YOU/.grok/auth.json), or set a Grok API key.",
  );
}

/**
 * Zotero / Firefox FileStore using IOUtils + PathUtils.
 */
export function createZoteroFileStore(): FileStore {
  const g = globalThis as any;
  const IOUtils = g.IOUtils;
  const PathUtils = g.PathUtils;
  if (!IOUtils || !PathUtils) {
    throw new Error("IOUtils/PathUtils not available (not running in Zotero?)");
  }

  /**
   * PathUtils.join only accepts a *single* path segment as each extra arg.
   * `join(home, "Documents/paper/zotero")` throws NS_ERROR_FILE_UNRECOGNIZED_PATH.
   * Split on / and \ and join one segment at a time.
   */
  const join = (...parts: string[]) => {
    let acc = "";
    for (const raw of parts) {
      if (raw == null || raw === "") continue;
      const part = String(raw);
      const segs = part.split(/[/\\]+/).filter((s) => s.length > 0);

      if (part.startsWith("/") || part === "/") {
        // Unix absolute: rebuild from /
        acc = "/";
        for (const seg of segs) {
          acc = acc === "/" ? `/${seg}` : PathUtils.join(acc, seg);
        }
        if (!segs.length) acc = "/";
        continue;
      }

      if (/^[A-Za-z]:[\\/]?/.test(part)) {
        // Windows absolute: first segment is drive (C:)
        acc = segs[0] || part.slice(0, 2);
        for (let i = 1; i < segs.length; i++) {
          acc = PathUtils.join(acc, segs[i]);
        }
        continue;
      }

      for (const seg of segs) {
        acc = acc ? PathUtils.join(acc, seg) : seg;
      }
    }
    return acc;
  };

  const resolvePath = (p: string): string => {
    let path = (p || "").trim();
    if (!path) return path;
    if (path === "~") return resolveZoteroHomeDir();
    if (path.startsWith("~/") || path.startsWith("~\\")) {
      const rest = path.slice(2).replace(/^[/\\]+/, "");
      path = rest ? join(resolveZoteroHomeDir(), rest) : resolveZoteroHomeDir();
    } else if (!isAbsoluteFsPath(path)) {
      // Relative → under home (PathUtils rejects bare relative multi-seg paths)
      path = join(resolveZoteroHomeDir(), path.replace(/^[/\\]+/, ""));
    }
    // Normalize trailing slashes; keep absolute root
    const stripped = path.replace(/[/\\]+$/, "");
    return stripped || path;
  };

  return {
    homeDir() {
      return resolveZoteroHomeDir();
    },
    join,
    resolvePath,
    async exists(p: string) {
      return IOUtils.exists(resolvePath(p));
    },
    async readText(p: string) {
      return IOUtils.readUTF8(resolvePath(p));
    },
    async writeText(p: string, data: string) {
      const path = resolvePath(p);
      const parent = PathUtils.parent(path);
      if (parent)
        await IOUtils.makeDirectory(parent, { createAncestors: true });
      const tmp = `${path}.tmp`;
      await IOUtils.writeUTF8(tmp, data);
      await IOUtils.move(tmp, path, { noOverwrite: false });
    },
    async withLock<T>(lockPath: string, fn: () => Promise<T>) {
      const path = resolvePath(lockPath);
      const parent = PathUtils.parent(path);
      if (parent)
        await IOUtils.makeDirectory(parent, { createAncestors: true });
      return softFileLock(
        path,
        async (lp) => {
          await IOUtils.writeUTF8(lp, String(Date.now()));
        },
        async (lp) => {
          await IOUtils.remove(lp);
        },
        async (lp) => IOUtils.exists(lp),
        (ms) => new Promise((r) => setTimeout(r, ms)),
        fn,
      );
    },
    async listDir(p: string) {
      const path = resolvePath(p);
      try {
        if (!(await IOUtils.exists(path))) return [];
        // Firefox / Zotero: getChildren returns absolute paths
        const children: string[] =
          (await IOUtils.getChildren?.(path)) ||
          (await IOUtils.getDirectoryEntries?.(path)) ||
          [];
        return children.map((c) => {
          const s = String(c);
          const parts = s.replace(/\\/g, "/").split("/");
          return parts[parts.length - 1] || s;
        });
      } catch {
        return [];
      }
    },
  };
}
