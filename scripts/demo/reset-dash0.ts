// T10: remove what the last demo run imported into Dash0, and nothing else. Reads the import manifest that
// `dd2dash0 migrate` writes (<out>/dash0/import-manifest.json) and deletes only items that run imported: dashboards
// by their dd-<datadog id> origin, check rules by their UUIDv5 id (T6, version nibble 5). The org is shared: anything
// not in that manifest is never touched.
//
//   npx tsx --env-file=.env scripts/demo/reset-dash0.ts [--out out/demo]          # lists what it would delete
//   npx tsx --env-file=.env scripts/demo/reset-dash0.ts [--out out/demo] --yes    # deletes
import { existsSync, readFileSync } from "node:fs";

interface ManifestItem {
  kind: "dashboard" | "check-rule";
  id: string;
  name: string;
  action: string;
}

const OURS = { dashboard: /^dd-[A-Za-z0-9_-]+$/, "check-rule": /^(dd-[a-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/ } as const;

export function deletable(manifest: { dryRun?: boolean; results?: ManifestItem[] }): ManifestItem[] {
  if (manifest.dryRun) return [];
  return (manifest.results ?? []).filter((r) => r.action === "imported" && OURS[r.kind]?.test(r.id));
}

export function deletePath(item: ManifestItem): string {
  const id = encodeURIComponent(item.id);
  return item.kind === "dashboard" ? `/api/dashboards/${id}` : `/api/alerting/check-rules/${id}`;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : "out/demo";
  const yes = args.includes("--yes");
  const path = `${out}/dash0/import-manifest.json`;
  if (!existsSync(path)) throw new Error(`no manifest at ${path}; run 'dd2dash0 migrate ... --out ${out}' first`);
  const items = deletable(JSON.parse(readFileSync(path, "utf8")));
  if (items.length === 0) {
    console.log(`nothing to delete (manifest ${path} lists no items this tool imported)`);
    return;
  }
  for (const i of items) console.log(`${yes ? "deleting" : "would delete"} ${i.kind} ${i.id} "${i.name}"`);
  if (!yes) {
    console.log("\nre-run with --yes to delete these");
    return;
  }
  const apiUrl = process.env.DASH0_API_URL;
  const token = process.env.DASH0_AUTH_TOKEN;
  if (!apiUrl || !token) throw new Error("DASH0_API_URL and DASH0_AUTH_TOKEN must be set (use --env-file=.env)");
  const dataset = process.env.DASH0_DATASET;
  let failed = 0;
  for (const i of items) {
    const url = new URL(deletePath(i), apiUrl);
    if (dataset) url.searchParams.set("dataset", dataset);
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok || res.status === 404) console.log(`  ${res.status === 404 ? "already gone" : "deleted"}: ${i.kind} ${i.id}`);
    else {
      failed++;
      console.error(`  failed ${res.status}: ${i.kind} ${i.id} ${(await res.text()).slice(0, 300)}`);
    }
  }
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`reset-dash0: ${e.message}`);
    process.exit(1);
  });
}
