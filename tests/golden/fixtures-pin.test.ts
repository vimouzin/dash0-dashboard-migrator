// The fixtures are COPIES of DataDog/integrations-core at commit a9b9e42b7e48 (fixtures/datadog/README.md). Two checks make
// "pinned" a fact and not a sentence:
//  1. each fixture's sha256 equals the hash recorded below (so nobody edits a fixture by accident);
//  2. when the corpus is checked out, each fixture is byte-identical to the same file in it, and that corpus is the
//     commit-stamped zip (GitHub writes the commit sha into the zip comment: a9b9e42b7e484861ecbd1f5919da7c52a694b74d).
// To re-pin: copy the new files, update PINNED_COMMIT in the README, and replace the hashes here in the same PR.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const FIX = join(ROOT, "fixtures", "datadog");
const PINNED_COMMIT = "a9b9e42b7e48";

/** sha256 of each fixture, taken from files verified byte-identical to the pinned commit. */
const SHA256: Record<string, string> = {
  "dashboards/nginx__NGINX-Overview_dashboard.json": "a2c58f6c7d3e54ec83efcc32f3a1d655a99e3e042778899a5ba8c49eb379f020",
  "dashboards/postgres__postgresql_dashboard.json": "9582909ceeb35c90fa13e9fcc56e32af0113e447aaeb3b4a1b4199efa0928c43",
  "dashboards/postgres__postgresql_screenboard_dashboard.json": "767cb4c94e2ea92c72976a80237f3728333121255759215e5607f396a35348ef",
  "dashboards/redisdb__overview.json": "75f939abc4adbc1bb23adfd084ac9e79865e57d91262b1fea40736363fbf2722",
  "monitors/nginx__5xx.json": "3699195d7965862ce890e883dfa6289421baea054f57b4bf3e3abff53740ad7c",
  "monitors/nginx__conn_dropped.json": "ed55d06804ecb70741c3f946ec16f2d22887b718b2fdc350470fd625e219a49e",
  "monitors/nginx__upstream_latency.json": "751740b105add5030b93ab91595b3a5b26c81c572470b315bccb029cc078d1d0",
  "monitors/postgres__percent_usage_connections.json": "bee9f93e3a2382d8181d0a8831519c3c0c8ee73eb85d3a2ddfef1d5444c5a084",
  "monitors/postgres__replication_delay.json": "2f80ae825ba6afb93ee99bceb9a71992324459136f5a299ac96d91667922f0bf",
  "monitors/redisdb__high_mem.json": "575faaa68c61f088ee9ab393a0304374479f57438e2e5859f9cce9d00f1c4168",
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("fixtures are pinned to integrations-core", () => {
  it(`the README names commit ${PINNED_COMMIT}`, () => {
    expect(readFileSync(join(FIX, "README.md"), "utf8")).toContain(PINNED_COMMIT);
  });
  it.each(Object.entries(SHA256))("%s has the pinned sha256", (rel, hash) => {
    expect(sha(readFileSync(join(FIX, rel)))).toBe(hash);
  });

  const corpus = [process.env.DD_CORPUS_DIR, resolve(process.cwd(), "../../corpus/integrations-core-master"), resolve(process.cwd(), "../corpus/integrations-core-master")].filter((p): p is string => !!p).find((p) => existsSync(p));
  describe.skipIf(!corpus)("against the checked-out corpus (skipped when absent)", () => {
    it.each(Object.keys(SHA256))("%s is byte-identical to the corpus file", (rel) => {
      const [sub, name] = rel.split("/") as [string, string];
      const [integration, ...rest] = name.split("__");
      const src = join(corpus!, integration!, "assets", sub, rest.join("__"));
      expect(existsSync(src), src).toBe(true);
      expect(sha(readFileSync(join(FIX, rel)))).toBe(sha(readFileSync(src)));
    });
  });
});
