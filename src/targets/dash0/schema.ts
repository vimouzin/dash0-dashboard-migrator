// Dash0 payload types, written from Dash0's OpenAPI spec (https://www.dash0.com/docs/api-reference/openapi.json,
// read 2026-11-07) and the dash0-cli test fixtures. HOT file (owned by T7): T5 and T6 build these shapes.
// Only the fields we emit are typed; the Perses panel internals stay loose here (T5 owns them).

/** OpenAPI `Duration`: (\d+(ms|s|m|h|d|w|M|Q|y))+ , e.g. "1m", "5m0s". */
export type Duration = string;

/** OpenAPI `CheckThresholds`. With `$__threshold` in the expression, at least one of degraded/failed is required. */
export interface CheckThresholds {
  degraded?: number;
  failed?: number;
}

/** OpenAPI `PrometheusAlertRule` (required: name, expression). Body of POST /api/import/check-rule. */
export interface PrometheusAlertRule {
  /** User-defined id for get/update/delete through the API. We set dd-<source id>. */
  id?: string;
  name: string;
  expression: string;
  thresholds?: CheckThresholds;
  /** Evaluation frequency, default "1m". */
  interval?: Duration;
  /** Pending duration. A Datadog lookback window never goes here (knowledge base D-27). */
  for?: Duration;
  keep_firing_for?: Duration;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** Defaults to true on Dash0's side. We default to false unless --enable-rules (knowledge base D-30). */
  enabled?: boolean;
}

export interface PersesPanel {
  kind: "Panel";
  spec: {
    display: { name: string; description?: string };
    plugin: { kind: string; spec: Record<string, unknown> };
    queries?: {
      kind: "TimeSeriesQuery";
      spec: { plugin: { kind: "PrometheusTimeSeriesQuery"; spec: { query: string; seriesNameFormat?: string } } };
    }[];
  };
}

export interface GridItem {
  x: number;
  y: number;
  width: number;
  height: number;
  content: { $ref: string };
}

export interface GridLayout {
  kind: "Grid";
  spec: { display?: { title: string; collapse?: { open: boolean } }; items: GridItem[] };
}

/** OpenAPI `DashboardDefinition` (required: kind, metadata, spec). Body of POST /api/import/dashboard. */
export interface DashboardDefinition {
  kind: "Dashboard";
  metadata: {
    name: string;
    dash0Extensions?: { id?: string; tags?: string[]; dataset?: string };
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    display: { name: string; description?: string };
    duration?: string;
    refreshInterval?: string;
    variables?: unknown[];
    panels: Record<string, PersesPanel>;
    layouts: GridLayout[];
  };
}

/** OpenAPI `ErrorResponse`. */
export interface Dash0ErrorBody {
  error: { code: number; type?: string; message: string; traceId?: string };
}

/** Request limits from the API introduction (docs/research/dash0.md). */
export const LIMITS = { bodyBytes: 256 * 1024 } as const;
