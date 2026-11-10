// T6 as T8's AlertConverter (src/pipeline/alerts-interim.ts, PR #11): (alert, ctx) -> AlertConversion.
// T8 plugs it in with  alertConverter: makeAlertConverter(translateMonitor)  and deletes the interim converter.
// translateMonitor is passed in (not imported) so this file does not depend on T4's module path.
import type { Alert, Finding, Status } from "../../ir/index.js";
import type { MonitorQuery } from "../../parse/index.js";
import { translateAlert } from "./translate.js";
import type { CheckRule, LogMonitorTranslationLike, MonitorTranslationLike } from "./types.js";

/** The parts of T4's TranslateContext T6 uses; the rest is passed through to translateMonitor untouched. */
export interface ConverterContext {
  tag?: (ddTag: string) => string | undefined;
  /** Datadog handle -> Dash0 notification channel id (parseChannelMap of the user's channel file). */
  channels?: (handle: string) => string | undefined;
  [key: string]: unknown;
}

/** T8's AlertConversion, plus what T6 adds (epsilon, channels). */
export interface AlertConversion {
  rule: CheckRule | null;
  /** Dash0 origin for PUT /api/alerting/check-rules/{origin} (the body has no id; Dash0 rejects one). */
  origin: string;
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
  epsilon: string[];
  channels: string[];
}

export type T4MonitorTranslator<C> = (mq: MonitorQuery, t: { critical?: number; warning?: number }, ctx: C) => MonitorTranslationLike;

export type T12LogMonitorTranslator<C> = (query: string, t: { critical?: number; warning?: number; variables?: unknown[] }, ctx: C) => LogMonitorTranslationLike;

export function makeAlertConverter<C extends ConverterContext>(
  translateMonitor: T4MonitorTranslator<C>,
  opts: { keepManual?: boolean; translateLogMonitor?: T12LogMonitorTranslator<C> } = {},
) {
  return (alert: Alert, ctx: C): AlertConversion => {
    const logMon = opts.translateLogMonitor;
    const r = translateAlert(alert, {
      translateMonitor: (mq, t) => translateMonitor(mq, t, ctx),
      ...(logMon && { translateLogMonitor: (q: string, t: { critical?: number; warning?: number; variables?: unknown[] }) => logMon(q, t, ctx) }),
      ...(ctx.tag && { tag: ctx.tag }),
      ...(ctx.channels && { channels: ctx.channels }),
      ...(opts.keepManual && { keepManual: true }),
    });
    return {
      rule: r.rule,
      origin: r.origin,
      status: r.status,
      promql: r.rule?.expression ?? null,
      rules: r.rules,
      assumptions: r.assumptions,
      findings: r.findings,
      epsilon: r.epsilon,
      channels: r.channels,
    };
  };
}
