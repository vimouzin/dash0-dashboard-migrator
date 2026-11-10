import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Map,
  ListChecks,
  Table2,
  Upload,
  RotateCcw,
  Sun,
  Moon,
  AlertTriangle,
  X,
} from "lucide-react";
import { useReport } from "@/lib/report-store";
import { cn } from "@/lib/utils";
import { isReviewable } from "@/lib/review";
import { Button } from "@/components/ui/button";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/map", label: "Dashboard map", icon: Map },
  { to: "/items", label: "Items", icon: Table2 },
  { to: "/review", label: "Review", icon: ListChecks },
] as const;

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("mrc-theme");
    if (stored) setDark(stored === "dark");
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("mrc-theme", dark ? "dark" : "light");
  }, [dark, ready]);
  return (
    <Button
      variant="ghost"
      onClick={() => setDark((d) => !d)}
      className="flex w-full justify-start gap-2.5 px-3 py-2 text-sm hover:bg-sidebar-accent"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {dark ? "Light theme" : "Dark theme"}
    </Button>
  );
}

function ReportLoader() {
  const { loadText, resetToSample, isSample, sourceName, sha, loadError } = useReport();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => loadText(String(r.result ?? ""), f.name);
          r.readAsText(f);
          e.target.value = "";
        }}
      />
      <Button
        variant="ghost"
        onClick={() => input.current?.click()}
        className="flex w-full justify-start gap-2.5 px-3 py-2 text-sm hover:bg-sidebar-accent"
      >
        <Upload className="size-4" /> Load report.json
      </Button>
      {!isSample && (
        <Button
          variant="ghost"
          onClick={resetToSample}
          className="flex w-full justify-start gap-2.5 px-3 py-2 text-sm hover:bg-sidebar-accent"
        >
          <RotateCcw className="size-4" /> Reset to sample
        </Button>
      )}
      <div className="px-3 pt-2 text-xs text-muted-foreground">
        <div className="truncate" title={sourceName}>
          {sourceName}
        </div>
        <div className="font-mono" title={sha ?? undefined}>
          sha256 {sha ? sha.slice(0, 12) : "…"}
        </div>
      </div>
      {loadError && <p className="px-3 pt-1 text-xs text-destructive">{loadError}</p>}
    </div>
  );
}

function SampleBanner() {
  const { isSample } = useReport();
  const [hidden, setHidden] = useState(false);
  if (!isSample || hidden) return null;
  return (
    <div className="flex items-center gap-3 h-8 shrink-0 bg-warn px-5 text-[11px] font-mono text-warn-foreground">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="font-semibold">SAMPLE DATA · PREDICTED RESULTS, NOT TOOL OUTPUT</span>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setHidden(true)}
        className="ml-auto size-6 text-warn-foreground"
        aria-label="Hide banner"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { report, review } = useReport();
  const workItems = report.items.filter((i) => i.kind !== "group");
  const pending = report.items.filter((i) => isReviewable(i) && !review.decisions[i.id]).length;
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 pt-5 pb-6">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <span className="size-3 border border-foreground" />
            Migration Review
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Datadog to Dash0</div>
        </div>
        <nav className="space-y-6 px-2">
          {[
            { title: "Report", items: NAV.slice(0, 2) },
            { title: "Work", items: NAV.slice(2) },
          ].map((group) => (
            <div key={group.title}>
              <h2 className="section-label px-3 pb-2">{group.title}</h2>
              {group.items.map(({ to, label, icon: Icon }) => (
                <Link
                  key={to}
                  to={to}
                  className="flex h-10 items-center gap-2.5 border-l-2 border-transparent px-3 text-sm hover:bg-sidebar-accent"
                  activeProps={{ className: "bg-accent font-medium text-primary border-l-primary" }}
                  activeOptions={{ exact: true }}
                >
                  <Icon className="size-4" />
                  <span>{label}</span>
                  {to === "/items" && (
                    <span className="ml-auto font-mono text-xs">{workItems.length}</span>
                  )}
                  {to === "/review" && (
                    <span className="ml-auto font-mono text-[10px]">{pending} pending</span>
                  )}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto space-y-1 border-t border-sidebar-border px-2 py-3">
          <ReportLoader />
          <ThemeToggle />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-6 py-2">
          <h1 className="text-sm font-semibold">Datadog to Dash0 migration review</h1>
          <p className="text-xs text-muted-foreground">
            Every translation step is deterministic. This console only reads the report.
          </p>
        </header>
        <SampleBanner />
        <main className={cn("min-h-0 flex-1 overflow-y-auto")}>{children}</main>
      </div>
    </div>
  );
}
