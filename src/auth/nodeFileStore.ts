/** Node-only FileStore for unit tests and smoke scripts. Not bundled into XPI. */

import type { FileStore } from "./fileStore";
import { softFileLock } from "./fileStore";

export async function createNodeFileStore(): Promise<FileStore> {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");

  const resolvePath = (p: string): string => {
    let s = (p || "").trim();
    if (!s) return s;
    if (s === "~") return os.homedir();
    if (s.startsWith("~/") || s.startsWith("~\\")) {
      s = path.join(os.homedir(), s.slice(2));
    } else if (!path.isAbsolute(s)) {
      s = path.join(os.homedir(), s);
    }
    return s;
  };

  return {
    homeDir() {
      return os.homedir();
    },
    join(...parts: string[]) {
      return path.join(...parts);
    },
    resolvePath,
    async exists(p: string) {
      try {
        await fsp.access(resolvePath(p));
        return true;
      } catch {
        return false;
      }
    },
    async readText(p: string) {
      return fsp.readFile(resolvePath(p), "utf-8");
    },
    async writeText(p: string, data: string) {
      const full = resolvePath(p);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp`;
      await fsp.writeFile(tmp, data, { encoding: "utf-8", mode: 0o600 });
      await fsp.rename(tmp, full);
      try {
        await fsp.chmod(full, 0o600);
      } catch {
        /* ignore */
      }
    },
    async withLock<T>(lockPath: string, fn: () => Promise<T>) {
      const fullLock = resolvePath(lockPath);
      await fsp.mkdir(path.dirname(fullLock), { recursive: true });
      return softFileLock(
        fullLock,
        async (p) => {
          await fsp.writeFile(p, String(Date.now()), { flag: "wx" });
        },
        async (p) => {
          await fsp.unlink(p);
        },
        async (p) => {
          try {
            await fsp.access(p);
            return true;
          } catch {
            return false;
          }
        },
        (ms) => new Promise((r) => setTimeout(r, ms)),
        fn,
      );
    },
    async listDir(p: string) {
      try {
        return await fsp.readdir(resolvePath(p));
      } catch {
        return [];
      }
    },
  };
}
