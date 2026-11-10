// Deterministic name-based UUIDs (RFC 4122 §4.3, version 5: SHA-1). Same name, same UUID, on every machine and run.
// Why: POST /api/import/check-rule upserts when the body's `id` is a UUID (Ali's live probe, hub #289), so a UUID
// derived from the Datadog monitor id keeps the Import Check Rule API the brief names AND makes re-runs idempotent.
import { createHash } from "node:crypto";

/** RFC 4122 Appendix C name-space ids. */
export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Our own name space: uuidv5("https://github.com/vimouzin/dash0-dashboard-migrator", NAMESPACE_URL). Never change it. */
export const NAMESPACE_DD2DASH0 = "e083a5e8-a6b0-5f33-88b4-5c71d5d243f2";

function bytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}

export function uuidv5(name: string, namespace: string): string {
  const h = createHash("sha1").update(bytes(namespace)).update(Buffer.from(name, "utf8")).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The Dash0 check-rule id for a Datadog monitor. */
export function checkRuleUuid(datadogMonitorId: string): string {
  return uuidv5(`datadog:monitor:${datadogMonitorId}`, NAMESPACE_DD2DASH0);
}
