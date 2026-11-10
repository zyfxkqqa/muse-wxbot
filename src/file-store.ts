import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WechatBotBinding, WechatBotStore } from "./types.js";

export class FsWechatBotStore implements WechatBotStore {
  constructor(private readonly filePath: string) {}

  async save(binding: WechatBotBinding): Promise<WechatBotBinding> {
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
  }

  async listActive(): Promise<WechatBotBinding[]> {
    return this.readAll();
  }

  async markError(botId: string, error: string): Promise<void> {
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
  }

  // Clear a previously recorded error once the bot is fetching fine again,
  // so the error display auto-recovers. No-op (no write) when there is
  // nothing recorded, so a healthy every-8s poll does not rewrite the file.
  async clearError(botId: string): Promise<void> {
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
  }

  private async readAll(): Promise<WechatBotBinding[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as WechatBotBinding[];
    } catch {
      return [];
    }
  }

  private async writeAll(bindings: WechatBotBinding[]) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
  }
}
