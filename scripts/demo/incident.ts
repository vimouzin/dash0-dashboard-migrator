// T10 / wow-factor spec §5: cause the demo incident on purpose, then clean it up.
// It fills the demo Redis with tagged keys until used_memory crosses the high_mem monitor's threshold, so the
// Datadog monitor and the Dash0 rule we migrated from it both fire on the same incident.
//
//   npx tsx scripts/demo/incident.ts status                     used / max memory, policy, flood keys
//   npx tsx scripts/demo/incident.ts flood [--target 95] [--chunk 1mb] [--ttl 1h] [--dry-run] [--allow-eviction]
//   npx tsx scripts/demo/incident.ts reset                      delete every dd2dash0:flood:* key, nothing else
//
// Connection: --url or REDIS_URL (redis://[user:password@]host:port[/db], rediss:// for TLS); default
// redis://127.0.0.1:6379. Safety: it refuses an unbounded Redis (maxmemory 0) and, unless --allow-eviction, an
// allkeys-* eviction policy (that would evict other keys instead of filling memory). Every flood key has a TTL, so
// a forgotten reset still cleans itself up. Only keys matching dd2dash0:flood:* are ever written or deleted.
// No dependencies: a minimal RESP client over node:net / node:tls.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";

export const KEY_PREFIX = "dd2dash0:flood:";

// ------------------------------------------------------------------ RESP

export type Reply = string | number | null | RedisError | Reply[];
export class RedisError extends Error {}

/** A command as a RESP array of bulk strings. */
export function encode(args: (string | Buffer)[]): Buffer {
  const parts: Uint8Array[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = typeof a === "string" ? Buffer.from(a) : a;
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

/** Incremental RESP2 parser: feed bytes, take complete replies. */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Reply[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Reply[] = [];
    for (;;) {
      const r = this.parse(0);
      if (!r) break;
      out.push(r.value);
      this.buf = this.buf.subarray(r.next);
    }
    return out;
  }
  private line(at: number): { text: string; next: number } | null {
    const i = this.buf.indexOf("\r\n", at);
    return i < 0 ? null : { text: this.buf.toString("utf8", at, i), next: i + 2 };
  }
  private parse(at: number): { value: Reply; next: number } | null {
    if (at >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[at]!);
    const l = this.line(at + 1);
    if (!l) return null;
    switch (type) {
      case "+":
        return { value: l.text, next: l.next };
      case "-":
        return { value: new RedisError(l.text), next: l.next };
      case ":":
        return { value: Number(l.text), next: l.next };
      case "$": {
        const n = Number(l.text);
        if (n < 0) return { value: null, next: l.next };
        if (this.buf.length < l.next + n + 2) return null;
        return { value: this.buf.toString("utf8", l.next, l.next + n), next: l.next + n + 2 };
      }
      case "*": {
        const n = Number(l.text);
        if (n < 0) return { value: null, next: l.next };
        const items: Reply[] = [];
        let next = l.next;
        for (let i = 0; i < n; i++) {
          const r = this.parse(next);
          if (!r) return null;
          items.push(r.value);
          next = r.next;
        }
        return { value: items, next };
      }
      default:
        throw new Error(`unexpected RESP type '${type}'`);
    }
  }
}

export interface RedisConfig {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
}

export function parseRedisUrl(url: string): RedisConfig {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error(`not a redis:// or rediss:// URL: ${u.protocol}`);
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error(`bad database number in the URL: ${u.pathname}`);
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : 6379,
    tls: u.protocol === "rediss:",
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db,
  };
}

/** Anything that runs one Redis command and returns its reply (a real connection, or a fake in tests). */
export interface Redis {
  cmd(...args: (string | Buffer)[]): Promise<Reply>;
  close(): void;
}

/** One TCP (or TLS) connection; replies come back in order, so commands may be issued concurrently. */
export async function connectRedis(cfg: RedisConfig, timeoutMs = 5000): Promise<Redis> {
  const sock: Socket = await new Promise((resolve, reject) => {
    const s = cfg.tls ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : netConnect({ host: cfg.host, port: cfg.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`could not reach Redis at ${cfg.host}:${cfg.port} within ${timeoutMs} ms`));
    }, timeoutMs);
    s.once(cfg.tls ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const parser = new RespParser();
  const waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  sock.on("data", (chunk: Buffer) => {
    for (const r of parser.push(chunk)) waiting.shift()?.resolve(r);
  });
  const fail = (e: Error) => {
    while (waiting.length) waiting.shift()!.reject(e);
  };
  sock.on("error", fail);
  sock.on("close", () => fail(new Error("Redis connection closed")));
  const redis: Redis = {
    cmd: (...args) =>
      new Promise<Reply>((resolve, reject) => {
        waiting.push({ resolve, reject });
        sock.write(encode(args));
      }),
    close: () => sock.end(),
  };
  const must = async (...args: string[]) => {
    const r = await redis.cmd(...args);
    if (r instanceof RedisError) throw new Error(`${args[0]} failed: ${r.message}`);
  };
  if (cfg.password) await must("AUTH", ...(cfg.username ? [cfg.username] : []), cfg.password);
  if (cfg.db) await must("SELECT", String(cfg.db));
  return redis;
}

// ------------------------------------------------------------------ memory and the plan

export interface MemoryInfo {
  used: number;
  max: number;
  policy: string;
}

export async function memoryInfo(r: Redis): Promise<MemoryInfo> {
  const reply = await r.cmd("INFO", "memory");
  if (typeof reply !== "string") throw new Error(`INFO memory: unexpected reply ${reply instanceof Error ? reply.message : JSON.stringify(reply)}`);
  const field = (k: string) => new RegExp(`^${k}:(.*)$`, "m").exec(reply)?.[1]?.trim();
  const used = Number(field("used_memory"));
  const max = Number(field("maxmemory") ?? 0);
  if (!Number.isFinite(used)) throw new Error("INFO memory has no used_memory");
  return { used, max: Number.isFinite(max) ? max : 0, policy: field("maxmemory_policy") ?? "unknown" };
}

export const pct = (m: MemoryInfo) => (m.max > 0 ? (100 * m.used) / m.max : NaN);

/** Why a flood must not run, or null when it may. */
export function refusal(m: MemoryInfo, targetPct: number, allowEviction: boolean): string | null {
  if (!(targetPct > 0 && targetPct < 100)) return `--target must be between 0 and 100 (got ${targetPct})`;
  if (m.max <= 0) return "maxmemory is 0 (unbounded): flooding would use the host's memory instead of tripping the monitor. Set maxmemory on the demo Redis first.";
  if (/^allkeys-/.test(m.policy) && !allowEviction)
    return `maxmemory-policy is ${m.policy}: near the limit Redis would evict other keys (the load generator's) instead of filling up. Pass --allow-eviction if that is acceptable.`;
  return null;
}

const MB = 1024 * 1024;
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb)?$/i.exec(s.trim());
  if (!m) throw new Error(`not a size: '${s}' (use e.g. 512kb, 1mb)`);
  return Math.round(Number(m[1]) * { b: 1, kb: 1024, mb: MB }[(m[2] ?? "b").toLowerCase() as "b" | "kb" | "mb"]);
}
export function parseSeconds(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`not a duration: '${s}' (use e.g. 30m, 1h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[(m[2] ?? "s") as "s" | "m" | "h"];
}

// ------------------------------------------------------------------ flood / reset / count

export interface FloodOptions {
  targetPct: number;
  chunkBytes: number;
  ttlSeconds: number;
  dryRun: boolean;
  allowEviction: boolean;
  log?: (line: string) => void;
}

export interface FloodResult {
  before: MemoryInfo;
  after: MemoryInfo;
  keysWritten: number;
  bytesWritten: number;
  stopped: "target-reached" | "already-above" | "dry-run" | "oom" | "safety-cap";
}

export async function flood(r: Redis, o: FloodOptions): Promise<FloodResult> {
  const log = o.log ?? (() => {});
  const before = await memoryInfo(r);
  const no = refusal(before, o.targetPct, o.allowEviction);
  if (no) throw new Error(no);
  const target = (o.targetPct / 100) * before.max;
  const needed = Math.max(0, target - before.used);
  log(`Redis memory ${(before.used / MB).toFixed(1)} of ${(before.max / MB).toFixed(1)} MiB (${pct(before).toFixed(1)}%), policy ${before.policy}; target ${o.targetPct}%.`);
  if (before.used >= target) return { before, after: before, keysWritten: 0, bytesWritten: 0, stopped: "already-above" };
  if (o.dryRun) {
    log(`dry run: would write about ${Math.ceil(needed / o.chunkBytes)} keys of ${(o.chunkBytes / 1024).toFixed(0)} KiB (${KEY_PREFIX}*, TTL ${o.ttlSeconds}s). Nothing written.`);
    return { before, after: before, keysWritten: 0, bytesWritten: 0, stopped: "dry-run" };
  }
  const value = Buffer.alloc(o.chunkBytes, 0x78); // "xxxx…": Redis stores strings as-is, no compression
  // Never write more than maxmemory in total, whatever INFO says (a guard against a Redis that misreports).
  const cap = before.max;
  // Continue after any flood keys already there, so a second flood adds memory instead of rewriting the same keys.
  const existing = await floodKeys(r);
  const start = existing.reduce((m, k) => Math.max(m, Number(k.slice(KEY_PREFIX.length)) + 1 || 0), 0);
  let keys = 0;
  let bytes = 0;
  let now = before;
  let stopped: FloodResult["stopped"] = "target-reached";
  while (now.used < target) {
    if (bytes >= cap) {
      stopped = "safety-cap";
      break;
    }
    const batch = Math.max(1, Math.min(16, Math.ceil((target - now.used) / o.chunkBytes)));
    const replies = await Promise.all(
      Array.from({ length: batch }, (_, i) => r.cmd("SET", `${KEY_PREFIX}${start + keys + i}`, value, "EX", String(o.ttlSeconds))),
    );
    const oom = replies.find((x) => x instanceof RedisError);
    const ok = replies.filter((x) => !(x instanceof RedisError)).length;
    keys += ok;
    bytes += ok * o.chunkBytes;
    now = await memoryInfo(r);
    log(`  wrote ${keys} keys, ${(bytes / MB).toFixed(0)} MiB: memory ${pct(now).toFixed(1)}%`);
    if (oom) {
      log(`  Redis refused a write (${(oom as RedisError).message}); stopping.`);
      stopped = "oom";
      break;
    }
  }
  return { before, after: now, keysWritten: keys, bytesWritten: bytes, stopped };
}

/** Every dd2dash0:flood:* key, found with SCAN (never KEYS, so a big Redis is not blocked). */
export async function floodKeys(r: Redis): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const reply = await r.cmd("SCAN", cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", "500");
    if (!Array.isArray(reply) || reply.length !== 2) throw new Error(`SCAN: unexpected reply ${JSON.stringify(reply)}`);
    cursor = String(reply[0]);
    for (const k of reply[1] as Reply[]) if (typeof k === "string" && k.startsWith(KEY_PREFIX)) out.push(k);
  } while (cursor !== "0");
  return [...new Set(out)];
}

/** Delete the flood keys (UNLINK: freed in the background), and only those. */
export async function reset(r: Redis): Promise<number> {
  const keys = await floodKeys(r);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 500) {
    const n = await r.cmd("UNLINK", ...keys.slice(i, i + 500));
    if (n instanceof RedisError) throw new Error(`UNLINK failed: ${n.message}`);
    deleted += typeof n === "number" ? n : 0;
  }
  return deleted;
}

// ------------------------------------------------------------------ CLI

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, log: (l: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!cmd || !["status", "flood", "reset"].includes(cmd)) {
    log("usage: incident.ts status | flood [--target 95] [--chunk 1mb] [--ttl 1h] [--dry-run] [--allow-eviction] | reset   [--url redis://host:6379]");
    return 3;
  }
  let r: Redis | null = null;
  try {
    const cfg = parseRedisUrl(flag("--url") ?? env.REDIS_URL ?? "redis://127.0.0.1:6379");
    r = await connectRedis(cfg);
    const where = `${cfg.host}:${cfg.port}${cfg.db ? `/${cfg.db}` : ""}`;
    if (cmd === "status") {
      const m = await memoryInfo(r);
      const keys = await floodKeys(r);
      log(`Redis ${where}: memory ${(m.used / MB).toFixed(1)} MiB of ${m.max ? `${(m.max / MB).toFixed(1)} MiB (${pct(m).toFixed(1)}%)` : "unbounded (maxmemory 0)"}, policy ${m.policy}, ${keys.length} flood keys.`);
      return 0;
    }
    if (cmd === "reset") {
      const n = await reset(r);
      const m = await memoryInfo(r);
      log(`Redis ${where}: deleted ${n} ${KEY_PREFIX}* keys; memory now ${pct(m).toFixed(1)}% (freeing is asynchronous, give it a few seconds).`);
      return 0;
    }
    const res = await flood(r, {
      targetPct: Number(flag("--target") ?? 95),
      chunkBytes: parseSize(flag("--chunk") ?? "1mb"),
      ttlSeconds: parseSeconds(flag("--ttl") ?? "1h"),
      dryRun: rest.includes("--dry-run"),
      allowEviction: rest.includes("--allow-eviction"),
      log,
    });
    log(
      res.stopped === "already-above"
        ? `Already at ${pct(res.before).toFixed(1)}%: nothing written.`
        : res.stopped === "dry-run"
          ? "Dry run done."
          : `Redis ${where}: ${res.keysWritten} keys written; memory ${pct(res.before).toFixed(1)}% -> ${pct(res.after).toFixed(1)}% (${res.stopped}). Undo with: incident.ts reset`,
    );
    return res.stopped === "oom" || res.stopped === "safety-cap" ? 1 : 0;
  } catch (e) {
    log(`incident.ts: ${(e as Error).message}`);
    return 3;
  } finally {
    r?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
