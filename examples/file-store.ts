/**
 * A file-backed Store: one JSON file, advisory-locked per operation. Enough for
 * several processes on one host to share open decisions and seen receipts;
 * a fleet wants a real shared backend behind the same five operations.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Store } from "@overturo/mcp-authorize"

interface Entry {
  value: string
  expiresAt: number
}

export class FileStore implements Store {
  private readonly path: string
  private readonly lockPath: string
  private readonly now: () => number

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.path = path
    this.lockPath = `${path}.lock`
    this.now = opts.now ?? Date.now
    mkdirSync(dirname(path), { recursive: true })
  }

  async get(key: string): Promise<string | undefined> {
    return this.locked((entries) => {
      const entry = entries[key]
      if (!entry) return [entries, undefined]
      if (entry.expiresAt <= this.now()) {
        delete entries[key]
        return [entries, undefined]
      }
      return [entries, entry.value]
    })
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.locked((entries) => {
      entries[key] = { value, expiresAt: this.now() + ttlSeconds * 1000 }
      return [entries, undefined]
    })
  }

  async compareAndSet(key: string, expected: string | undefined, value: string, ttlSeconds: number): Promise<boolean> {
    return this.locked((entries) => {
      const entry = entries[key]
      const current = entry && entry.expiresAt > this.now() ? entry.value : undefined
      if (current !== expected) return [entries, false]
      entries[key] = { value, expiresAt: this.now() + ttlSeconds * 1000 }
      return [entries, true]
    })
  }

  async delete(key: string): Promise<void> {
    await this.locked((entries) => {
      delete entries[key]
      return [entries, undefined]
    })
  }

  async sweep(): Promise<void> {
    await this.locked((entries) => {
      for (const [k, e] of Object.entries(entries)) if (e.expiresAt <= this.now()) delete entries[k]
      return [entries, undefined]
    })
  }

  private async locked<T>(fn: (entries: Record<string, Entry>) => [Record<string, Entry>, T]): Promise<T> {
    const fd = await this.acquire()
    try {
      const entries = this.read()
      const [next, result] = fn(entries)
      this.write(next)
      return result
    } finally {
      closeSync(fd)
      try {
        const { unlinkSync } = await import("node:fs")
        unlinkSync(this.lockPath)
      } catch {
        // already gone
      }
    }
  }

  private async acquire(): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        return openSync(this.lockPath, "wx")
      } catch {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    throw new Error(`FileStore: could not lock ${this.lockPath}`)
  }

  private read(): Record<string, Entry> {
    if (!existsSync(this.path)) return {}
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Entry>
    } catch {
      return {}
    }
  }

  private write(entries: Record<string, Entry>): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
