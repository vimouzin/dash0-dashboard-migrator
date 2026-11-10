import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import sampleText from "@/data/report.sample.json?raw";
import { parseReport, type Report } from "./report";
import { sha256Hex } from "./fingerprint";
import {
  allowedDecisions,
  checklistComplete,
  emptyReview,
  storageKey,
  type Decision,
  type ReviewState,
} from "./review";

interface Loaded {
  report: Report;
  text: string;
  sourceName: string;
  isSample: boolean;
}

function loadSample(): Loaded {
  const r = parseReport(sampleText);
  if (!r.ok) throw new Error("Bundled sample is invalid: " + r.error);
  return { report: r.report, text: sampleText, sourceName: "report.sample.json", isSample: true };
}

interface Ctx {
  report: Report;
  sourceName: string;
  isSample: boolean;
  sha: string | null;
  loadError: string | null;
  loadText: (text: string, name: string) => void;
  resetToSample: () => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  review: ReviewState;
  setReviewer: (name: string) => void;
  decide: (id: string, d: Decision | null, note?: string) => void;
  setNote: (id: string, note: string) => void;
  setCheck: (id: string, key: string, v: boolean) => void;
  clearDecisions: () => void;
}

const ReportCtx = createContext<Ctx | null>(null);

export function ReportProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded>(loadSample);
  const [sha, setSha] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState>(emptyReview);
  const [reviewLoadedFor, setReviewLoadedFor] = useState<string | null>(null);

  // Try a report.json served from the public folder; fall back to the bundled sample.
  useEffect(() => {
    let alive = true;
    fetch("/report.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        if (!alive || !text) return;
        const r = parseReport(text);
        if (!r.ok) return;
        setSelectedId(null);
        setReviewLoadedFor(null);
        setLoaded({ report: r.report, text, sourceName: "report.json", isSample: false });
      })
      .catch(() => {
        /* no public report.json: keep the sample */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setSha(null);
    sha256Hex(loaded.text).then((h) => alive && setSha(h));
    return () => {
      alive = false;
    };
  }, [loaded.text]);

  // Load decisions stored under this report's fingerprint.
  useEffect(() => {
    if (!sha) return;
    let next = emptyReview();
    try {
      const raw = localStorage.getItem(storageKey(sha));
      if (raw) next = { ...next, ...JSON.parse(raw) };
    } catch {
      /* ignore corrupt storage */
    }
    setReview(next);
    setReviewLoadedFor(sha);
  }, [sha]);

  useEffect(() => {
    if (!sha || reviewLoadedFor !== sha) return;
    try {
      localStorage.setItem(storageKey(sha), JSON.stringify(review));
    } catch {
      /* storage full */
    }
  }, [review, sha, reviewLoadedFor]);

  const loadText = useCallback((text: string, name: string) => {
    const r = parseReport(text);
    if (!r.ok) {
      setLoadError(r.error);
      return;
    }
    setLoadError(null);
    setSelectedId(null);
    setReviewLoadedFor(null);
    setLoaded({ report: r.report, text, sourceName: name, isSample: false });
  }, []);

  const resetToSample = useCallback(() => {
    setLoadError(null);
    setSelectedId(null);
    setReviewLoadedFor(null);
    setLoaded(loadSample());
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      report: loaded.report,
      sourceName: loaded.sourceName,
      isSample: loaded.isSample || !!loaded.report.sampleNotice,
      sha,
      loadError,
      loadText,
      resetToSample,
      selectedId,
      select: setSelectedId,
      review,
      setReviewer: (reviewer) => setReview((s) => ({ ...s, reviewer })),
      decide: (id, d, note) =>
        setReview((s) => {
          const item = loaded.report.items.find((i) => i.id === id);
          if (
            !item ||
            (d &&
              (!allowedDecisions(item).includes(d) ||
                (item.kind === "monitor" && d === "approved" && !checklistComplete(s, id))))
          )
            return s;
          const decisions = { ...s.decisions };
          if (!d) delete decisions[id];
          else
            decisions[id] = {
              decision: d,
              note: note ?? s.decisions[id]?.note ?? "",
              at: new Date().toISOString(),
            };
          return { ...s, decisions };
        }),
      setNote: (id, note) =>
        setReview((s) => {
          const cur = s.decisions[id];
          if (!cur) return s;
          return { ...s, decisions: { ...s.decisions, [id]: { ...cur, note } } };
        }),
      setCheck: (id, key, v) =>
        setReview((s) => {
          const decisions = { ...s.decisions };
          if (!v && decisions[id]?.decision === "approved") delete decisions[id];
          return {
            ...s,
            decisions,
            checklist: { ...s.checklist, [id]: { ...(s.checklist[id] ?? {}), [key]: v } },
          };
        }),
      clearDecisions: () => setReview((s) => ({ ...s, decisions: {}, checklist: {} })),
    }),
    [loaded, sha, loadError, loadText, resetToSample, selectedId, review],
  );

  return <ReportCtx.Provider value={value}>{children}</ReportCtx.Provider>;
}

export function useReport(): Ctx {
  const c = useContext(ReportCtx);
  if (!c) throw new Error("useReport outside ReportProvider");
  return c;
}
