// Datadog notification handles -> existing Dash0 notification channels (brief p.7: "supported notification settings").
// The mapping is a reviewed file the user writes; T6 never creates or guesses a channel. Example:
//
//   # Datadog handle -> Dash0 notification channel id (Settings -> Notification channels)
//   channels:
//     "@slack-ops-alerts": 6f1c2a8e-0b0d-4c1e-9a52-3d1f0e7b9c44
//     "@pagerduty-db": 9b7e4d21-55aa-4f0e-8c3b-2a6d1e9f0a13
//
// Dash0 binds a check rule to channels with the annotation `dash0.com/notification-channel-ids` (comma-separated ids;
// an `:critical-only` suffix restricts that channel to critical notifications). Source: Dash0 OpenAPI,
// NotificationChannelRouting.assets.
import { parse } from "yaml";

export type ChannelLookup = (handle: string) => string | undefined;

const norm = (h: string) => (h.startsWith("@") ? h : `@${h}`).toLowerCase();

/** Parse a channel map. Throws on a malformed file, so a typo can't silently drop a channel. */
export function parseChannelMap(text: string, file = "<notification-channels>"): ChannelLookup {
  const doc = parse(text) as { channels?: Record<string, unknown> } | null;
  const raw = doc?.channels ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: 'channels' must be a map of handle -> channel id`);
  const map = new Map<string, string>();
  for (const [handle, id] of Object.entries(raw)) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`${file}: channel id for ${handle} must be a non-empty id string`);
    map.set(norm(handle), id);
  }
  return (handle) => map.get(norm(handle));
}

/** The annotation key Dash0 reads. */
export const CHANNEL_ANNOTATION = "dash0.com/notification-channel-ids";
