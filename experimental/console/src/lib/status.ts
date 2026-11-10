import {
  CheckCircle2,
  AlertTriangle,
  Ban,
  CircleSlash,
  XOctagon,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import type { Status } from "./report";

export interface StatusMeta {
  label: string;
  short: string;
  icon: LucideIcon;
  /** suffix of the CSS token: --status-<token> */
  token: string;
  copy: string;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  exact: {
    label: "Exact",
    short: "Exact",
    icon: CheckCircle2,
    token: "exact",
    copy: "Query translated without a known semantic change.",
  },
  approximate: {
    label: "Approximate",
    short: "Approximate",
    icon: AlertTriangle,
    token: "approx",
    copy: "Translation generated. Review the semantic differences.",
  },
  no_data: {
    label: "No equivalent metric",
    short: "No equivalent",
    icon: CircleSlash,
    token: "nodata",
    copy: "No matching metric in the OpenTelemetry mapping. Imported as a placeholder.",
  },
  unsupported: {
    label: "Unsupported",
    short: "Unsupported",
    icon: Ban,
    token: "unsupported",
    copy: "This translator does not support this widget type. Imported as a placeholder.",
  },
  failed: {
    label: "Failed",
    short: "Failed",
    icon: XOctagon,
    token: "failed",
    copy: "Translation could not be completed. See the diagnostic.",
  },
};

export const UNKNOWN_META: StatusMeta = {
  label: "Unknown",
  short: "Unknown",
  icon: HelpCircle,
  token: "nodata",
  copy: "This status is not recognised by the console.",
};

export const metaFor = (s: string): StatusMeta => STATUS_META[s as Status] ?? UNKNOWN_META;

/** Risk order for review queue: lower = reviewed first. */
export const RISK_ORDER: Record<string, number> = {
  failed: 1,
  unsupported: 2,
  no_data: 3,
  approximate: 4,
  exact: 9,
};

export const COPY = {
  reviewRequired: "Human decision needed before import.",
  approved: "Import authorised. Translation remains approximate.",
  empty: "No items match these filters.",
  export: "Export review decisions as review.json.",
  noSamples: "Translated, but no samples have arrived yet.",
};
