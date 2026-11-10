// scripts/demo/incident.ts: the RESP client, the safety refusals, flood/reset against an in-memory Redis, and the
// whole CLI over a real TCP socket to a fake RESP server (there is no Redis in CI).
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  encode,
  flood,
  floodKeys,
  KEY_PREFIX,
  main,
  parseRedisUrl,
  parseSeconds,
  parseSize,
  refusal,
  RedisError,
  RespParser,
  reset,
  type Redis,
  type Reply,
} from "../../scripts/demo/incident.js";

/** An in-memory Redis: memory = base + the bytes of every value stored; refuses writes over maxmemory (noeviction). */
class FakeRedis implements Redis {
  data = new Map<string, { value: string; ttl: number | null }>();
  sets: string[][] = [];
  constructor(
    public base: number,
    public max: number,
    public policy = "noeviction",
  ) {
    this.data.set("loadgen:1", { value: "keep me", ttl: null });
  }
  get used() {
    let n = this.base;
    for (const v of this.data.values()) n += v.value.length;
    return n;
  }
  async cmd(...args: (string | Buffer)[]): Promise<Reply> {
    const a = args.map((x) => (typeof x === "string" ? x : x.toString("utf8")));
    switch (a[0]!.toUpperCase()) {
      case "INFO":
        return `# Memory\r\nused_memory:${this.used}\r\nmaxmemory:${this.max}\r\nmaxmemory_policy:${this.policy}\r\n`;
      case "SET": {
        this.sets.push(a.slice(0, 1).concat(a[1]!, String(a[2]!.length), ...a.slice(3)));
        if (this.max && this.used + a[2]!.length > this.max) return new RedisError("OOM command not allowed when used memory > 'maxmemory'.");
        this.data.set(a[1]!, { value: a[2]!, ttl: a[3] === "EX" ? Number(a[4]) : null });
        return "OK";
      }
      case "SCAN": {
        const pattern = a[3]!.replace(/\*$/, "");
        return ["0", [...this.data.keys()].filter((k) => k.startsWith(pattern))];
      }
      case "UNLINK":
        return a.slice(1).filter((k) => this.data.delete(k)).length;
      case "PING":
        return "PONG";
      default:
        return new RedisError(`ERR unknown command '${a[0]}'`);
    }
  }
  close() {}
}

const MB = 1024 * 1024;
const opts = { targetPct: 95, chunkBytes: MB, ttlSeconds: 3600, dryRun: false, allowEviction: false };

describe("RESP", () => {
  it("encodes commands as arrays of bulk strings", () => {
    expect(encode(["SET", "k", Buffer.from("v1")]).toString()).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\nv1\r\n");
  });
  it("parses every reply type, also when bytes arrive in pieces", () => {
    const p = new RespParser();
    const wire = "+OK\r\n-ERR nope\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n";
    const out: Reply[] = [];
    for (const ch of wire) out.push(...p.push(Buffer.from(ch)));
    expect(out[0]).toBe("OK");
    expect(out[1]).toBeInstanceOf(RedisError);
    expect((out[1] as Error).message).toBe("ERR nope");
    expect(out.slice(2)).toEqual([42, "hello", null, ["0", ["a", "b"]]]);
  });
  it("reads redis:// and rediss:// URLs, with credentials and a database", () => {
    expect(parseRedisUrl("redis://127.0.0.1:6380")).toEqual({ host: "127.0.0.1", port: 6380, tls: false, db: 0 });
    expect(parseRedisUrl("rediss://u:p%40ss@redis.example:6390/2")).toEqual({ host: "redis.example", port: 6390, tls: true, username: "u", password: "p@ss", db: 2 });
    expect(() => parseRedisUrl("http://x")).toThrow(/redis:\/\//);
    expect(parseSize("512kb")).toBe(512 * 1024);
    expect(parseSeconds("1h")).toBe(3600);
  });
});

describe("safety", () => {
  it("refuses an unbounded Redis, an allkeys-* policy without --allow-eviction, and a silly target", () => {
    expect(refusal({ used: 1, max: 0, policy: "noeviction" }, 95, false)).toMatch(/maxmemory is 0/);
    expect(refusal({ used: 1, max: 10, policy: "allkeys-lru" }, 95, false)).toMatch(/evict other keys/);
    expect(refusal({ used: 1, max: 10, policy: "allkeys-lru" }, 95, true)).toBeNull();
    expect(refusal({ used: 1, max: 10, policy: "volatile-lru" }, 95, false)).toBeNull();
    expect(refusal({ used: 1, max: 10, policy: "noeviction" }, 100, false)).toMatch(/--target/);
  });
  it("a refused flood writes nothing", async () => {
    const r = new FakeRedis(10 * MB, 0);
    await expect(flood(r, opts)).rejects.toThrow(/maxmemory is 0/);
    expect(r.sets).toEqual([]);
  });
});

describe("flood and reset", () => {
  it("fills to the target with TTL'd flood keys only, then reset removes exactly those", async () => {
    const r = new FakeRedis(40 * MB, 100 * MB);
    const res = await flood(r, opts);
    expect(res.stopped).toBe("target-reached");
    expect(r.used / r.max).toBeGreaterThanOrEqual(0.95);
    expect(r.used / r.max).toBeLessThan(0.97); // stops right after the target, not at the limit
    expect(r.sets.every((s) => s[1]!.startsWith(KEY_PREFIX) && s[3] === "EX" && s[4] === "3600")).toBe(true);
    expect(await reset(r)).toBe(res.keysWritten);
    expect([...r.data.keys()]).toEqual(["loadgen:1"]); // nothing else touched
    expect(r.used).toBe(40 * MB + "keep me".length);
  });
  it("a second flood adds new keys instead of rewriting the first ones", async () => {
    const r = new FakeRedis(10 * MB, 100 * MB);
    await flood(r, { ...opts, targetPct: 30 });
    const first = (await floodKeys(r)).length;
    await flood(r, { ...opts, targetPct: 60 });
    expect((await floodKeys(r)).length).toBeGreaterThan(first);
    expect(r.used / r.max).toBeGreaterThanOrEqual(0.6);
  });
  it("dry run and already-above write nothing", async () => {
    const r = new FakeRedis(40 * MB, 100 * MB);
    const lines: string[] = [];
    expect((await flood(r, { ...opts, dryRun: true, log: (l) => lines.push(l) })).stopped).toBe("dry-run");
    expect(lines.join("\n")).toMatch(/would write about 55 keys of 1024 KiB/); // (95 - 40) MiB in 1 MiB keys
    expect(r.sets).toEqual([]);
    const full = new FakeRedis(97 * MB, 100 * MB);
    expect((await flood(full, opts)).stopped).toBe("already-above");
    expect(full.sets).toEqual([]);
  });
  it("stops cleanly when Redis refuses a write (OOM)", async () => {
    const r = new FakeRedis(40 * MB, 100 * MB);
    const res = await flood(r, { ...opts, targetPct: 99.9, chunkBytes: 7 * MB });
    expect(res.stopped).toBe("oom");
    expect(r.used).toBeLessThanOrEqual(r.max);
  });
});

describe("the CLI over a real socket", () => {
  const backend = new FakeRedis(40 * MB, 100 * MB);
  let server: Server;
  let url = "";
  const auth: string[][] = [];
  afterAll(() => server?.close());

  it("status, flood and reset end to end; AUTH and SELECT come from the URL", async () => {
    server = createServer((sock) => {
      const p = new RespParser();
      sock.on("data", async (chunk) => {
        for (const cmd of p.push(chunk)) {
          const args = cmd as string[];
          let reply: Reply;
          if (args[0] === "AUTH" || args[0] === "SELECT") {
            auth.push(args);
            reply = "OK";
          } else reply = await backend.cmd(...args);
          sock.write(toWire(reply));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `redis://demo:secret@127.0.0.1:${(server.address() as AddressInfo).port}/3`;

    const out: string[] = [];
    const log = (l: string) => out.push(l);
    expect(await main(["status", "--url", url], {}, log)).toBe(0);
    expect(out.at(-1)).toMatch(/memory 40\.0 MiB of 100\.0 MiB \(40\.0%\), policy noeviction, 0 flood keys/);
    expect(await main(["flood", "--url", url, "--target", "92"], {}, log)).toBe(0);
    expect(out.at(-1)).toMatch(/keys written; memory 40\.0% -> 9[23]\.\d% \(target-reached\)/);
    expect(await main(["reset", "--url", url], {}, log)).toBe(0);
    expect(out.at(-1)).toMatch(/deleted 5[23] dd2dash0:flood:\* keys/);
    expect(auth).toContainEqual(["AUTH", "demo", "secret"]);
    expect(auth).toContainEqual(["SELECT", "3"]);
    expect(out.join("\n")).not.toContain("secret"); // the password is never printed
  });

  it("an unreachable Redis is a clear error, exit 3", async () => {
    const out: string[] = [];
    expect(await main(["status", "--url", "redis://127.0.0.1:1"], {}, (l) => out.push(l))).toBe(3);
    expect(out[0]).toMatch(/incident\.ts: /);
    expect(await main([], {}, () => {})).toBe(3);
  });
});

function toWire(r: Reply): string {
  if (r === null) return "$-1\r\n";
  if (r instanceof RedisError) return `-${r.message}\r\n`;
  if (typeof r === "number") return `:${r}\r\n`;
  if (Array.isArray(r)) return `*${r.length}\r\n${r.map(toWire).join("")}`;
  return `$${Buffer.byteLength(r)}\r\n${r}\r\n`;
}
