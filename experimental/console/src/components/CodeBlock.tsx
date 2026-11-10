import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({
  lines,
  copy = false,
  empty = "n/a",
}: {
  lines: string[];
  copy?: boolean;
  empty?: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-md bg-surface-2 px-3 py-2 font-mono text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-[2px] bg-surface">
      {lines.map((line, index) => (
        <div
          key={index}
          className="flex min-w-0 items-start gap-2 border-b border-border px-2 py-2 last:border-0"
        >
          <span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <code className="query-line min-w-0 flex-1">
            {line.split(/([+*/=,]|\s+)/).map((part, n) => (
              <span key={n}>
                {part}
                {/[+*/=,]/.test(part) && <wbr />}
              </span>
            ))}
          </code>
          {copy && <CopyButton text={line} />}
        </div>
      ))}
    </div>
  );
}
