import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WechatBotBinding, WechatBotStore } from "./types.js";

// P4 (H3/M7/M8): bindings.json hardening.
// - readAll distinguishes "file does not exist" (returns []) from "file is
//   corrupt" (backs the bad file up as bindings.json.corrupt-<ts> and throws;
//   callers must never continue to write on top of a corrupt file).
// - writeAll is atomic: write a temp file in the same directory, then rename.
// - Every read-modify-write (save / markError / clearError) runs under an
//   exclusive lock file, so concurrent CLI processes (one per bot polling
//   every 8s) cannot overwrite each other's cursor / lastError. Node has no
//   flock binding, so the lock is an O_EXCL create of <file>.lock (the same
//   single-writer semantics as the hook's flock on wechat-roster.json);
//   a lock older than 30s is treated as stale (crashed holder) and cleared.
export class FsWechatBotStore implements WechatBotStore {
  constructor(private readonly filePath: string) {}

  async save(binding: WechatBotBinding): Promise<WechatBotBinding> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const now = new Date().toISOString();
      const next = {
        ...binding,
        id: binding.id || randomUUID(),
        createdAt: binding.createdAt || now,
        updatedAt: now
      };
      const index = all.findIndex((item) => item.id === next.id || item.platformBotId === next.platformBotId);
      if (index >= 0) all[index] = next;
      else all.push(next);
      await this.writeAll(all);
      return next;
    });
  }

  async listActive(): Promise<WechatBotBinding[]> {
    return this.readAll();
  }

  async markError(botId: string, error: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readAll();
      const index = all.findIndex((item) => item.id === botId);
      if (index < 0) return;
      all[index] = {
        ...all[index],
        updatedAt: new Date().toISOString(),
        metadata: {
          ...all[index].metadata,
          lastError: error.slice(0, 500),
          lastErrorAt: new Date().toISOString()
        }
      };
      await this.writeAll(all);
    });
  }

  // Clear a previously recorded error once the bot is fetching fine again,
  // so the error display auto-recovers. No-op (no write) when there is
  // nothing recorded, so a healthy every-8s poll does not rewrite the file.
  async clearError(botId: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readAll();
      const index = all.findIndex((item) => item.id === botId);
      if (index < 0) return;
      const meta = { ...(all[index].metadata as Record<string, unknown> | undefined) };
      if (meta.lastError === undefined && meta.lastErrorAt === undefined) return;
      delete meta.lastError;
      delete meta.lastErrorAt;
      all[index] = {
        ...all[index],
        updatedAt: new Date().toISOString(),
        metadata: meta
      };
      await this.writeAll(all);
    });
  }

  private async readAll(): Promise<WechatBotBinding[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      // ENOENT (no bindings yet) is the only case that yields an empty list.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.backupCorrupt();
      throw new Error(
        `bindings 文件已损坏，无法解析（已备份为 ${this.corruptName()}，未写入任何内容）：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!Array.isArray(parsed)) {
      await this.backupCorrupt();
      throw new Error(`bindings 文件已损坏（顶层不是数组，已备份为 ${this.corruptName()}，未写入任何内容）`);
    }
    return parsed as WechatBotBinding[];
  }

  private corruptName(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `${this.filePath}.corrupt-${ts}`;
  }

  private async backupCorrupt(): Promise<void> {
    try {
      await copyFile(this.filePath, this.corruptName());
    } catch {
      /* best effort: the throw below still surfaces the corruption */
    }
  }

  private async writeAll(bindings: WechatBotBinding[]) {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Atomic write: land under a temp name in the same directory first and
    // rename only once complete, so a crash mid-write can never truncate
    // bindings.json (same standard as download-media's .part + rename).
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }

  private lockPath(): string {
    return `${this.filePath}.lock`;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockFile = this.lockPath();
    await mkdir(dirname(lockFile), { recursive: true });
    const deadline = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    for (;;) {
      try {
        handle = await open(lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        // Lock held by another process. If it is stale (>30s, crashed
        // holder), clear it and retry; otherwise wait and retry.
        try {
          const st = await stat(lockFile);
          if (Date.now() - st.mtimeMs > 30_000) {
            await rm(lockFile, { force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between stat and rm — retry
        }
        if (Date.now() > deadline) {
          throw new Error(`bindings 文件被锁超过 10 秒（${lockFile}），放弃写入以免覆盖其他进程的修改`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await handle!.close();
      } catch {
        /* ignore */
      }
      await rm(lockFile, { force: true }).catch(() => undefined);
    }
  }
}
