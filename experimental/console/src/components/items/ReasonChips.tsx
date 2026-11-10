import { reasonLabel } from "@/lib/presentation";

export function ReasonChips({ codes }: { codes: string[] }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {codes.map((code) => (
        <span
          key={code}
          className="console-chip h-auto min-h-[22px] max-w-full whitespace-normal py-0.5 text-body"
        >
          {reasonLabel(code)}
        </span>
      ))}
    </div>
  );
}
