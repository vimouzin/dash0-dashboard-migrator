// Markers -> TimeSeriesChart thresholds, conditional formats -> StatChart thresholds (Plan 07 item 3, catalog
// panel.markers / panel.conditional-format).
import { describe, it, expect } from "vitest";
import { conditionalFormatsToThresholds as cf, markersToThresholds as mk } from "../../src/translate/dashboard/thresholds.js";

const RED = "#e5484d", YEL = "#f5a623", GRN = "#30a46c";

describe("markers", () => {
  it("y = N lines keep value, severity colour and label, sorted ascending", () => {
    const r = mk([
      { label: " Max memory reached ", value: "y = 100", display_type: "error dashed" },
      { label: " 80% memory usage ", value: "y = 80", display_type: "warning dashed" },
    ]);
    expect(r.thresholds).toEqual({ mode: "absolute", steps: [{ value: 80, color: YEL, name: "80% memory usage" }, { value: 100, color: RED, name: "Max memory reached" }] });
    expect(r.notes).toEqual([]);
  });
  it("bands become their edge lines and say so", () => {
    const r = mk([{ value: "0 < y < 5", display_type: "ok" }, { value: "y >= -2.5", display_type: "info" }]);
    expect(r.thresholds!.steps.map((s) => s.value)).toEqual([-2.5, 0, 5]);
    expect(r.notes.join(" ")).toMatch(/'0 < y < 5' is a shaded band.*two edge lines/);
  });
  it("unrecognised values are skipped and returned; empty input gives no thresholds", () => {
    expect(mk([{ value: "x = 3" }]).skipped).toEqual(["x = 3"]);
    expect(mk([]).thresholds).toBeNull();
    expect(mk(undefined).thresholds).toBeNull();
  });
  it("the first marker wins on a duplicate value", () => {
    const r = mk([{ value: "y = 1", display_type: "error", label: "a" }, { value: "y = 1", display_type: "ok", label: "b" }]);
    expect(r.thresholds!.steps).toEqual([{ value: 1, color: RED, name: "a" }]);
  });
});

describe("conditional formats (Datadog: the first matching rule wins)", () => {
  it("overlapping rules: earlier rules shadow later ones", () => {
    // postgres screenboard: > 75 red, > 50 yellow, <= 50 green
    const r = cf([{ comparator: ">", palette: "white_on_red", value: 75 }, { comparator: ">", palette: "white_on_yellow", value: 50 }, { comparator: "<=", palette: "white_on_green", value: 50 }]);
    expect(r.thresholds).toEqual({ mode: "absolute", defaultColor: GRN, steps: [{ value: 50, color: YEL }, { value: 75, color: RED }] });
    // Perses steps are ">= value": the strict breakpoints differ only at the exact value, and the finding says so.
    expect(r.notes).toEqual(["a value of exactly 50 is green in Datadog, yellow in Dash0", "a value of exactly 75 is yellow in Datadog, red in Dash0"]);
  });
  it(">= breakpoints are exact", () => {
    const r = cf([{ comparator: "<", palette: "black_on_light_red", value: 1.5 }, { comparator: ">=", palette: "black_on_light_green", value: 1.5 }]);
    expect(r.thresholds).toEqual({ mode: "absolute", defaultColor: RED, steps: [{ value: 1.5, color: GRN }] });
    expect(r.notes).toEqual([]);
  });
  it("a gap no rule covers is reported, not hidden", () => {
    const r = cf([{ comparator: "<", palette: "white_on_red", value: 75 }, { comparator: "<=", palette: "white_on_yellow", value: 89 }, { comparator: ">=", palette: "white_on_green", value: 90 }]);
    expect(r.thresholds!.steps).toEqual([{ value: 75, color: YEL }, { value: 90, color: GRN }]);
    expect(r.notes).toEqual(["values in (89, 90) are no colour in Datadog, yellow in Dash0"]);
  });
  it("no colour below the first rule means no defaultColor", () => {
    expect(cf([{ comparator: ">", palette: "white_on_green", value: 0 }]).thresholds).toEqual({ mode: "absolute", steps: [{ value: 0, color: GRN }] });
  });
  it("custom hex colours are kept; unknown palettes, comparators or images are unsupported", () => {
    expect(cf([{ comparator: ">", palette: "custom_bg", custom_bg_color: "#ABCDEF", value: 1 }]).thresholds!.steps).toEqual([{ value: 1, color: "#abcdef" }]);
    expect(cf([{ comparator: ">", palette: "custom_image", image_url: "x", value: 1 }]).unsupported).toBeDefined();
    expect(cf([{ comparator: "=", palette: "white_on_red", value: 1 }]).unsupported).toBeDefined();
    expect(cf([{ comparator: ">", palette: "rainbow", value: 1 }]).thresholds).toBeNull();
  });
});
