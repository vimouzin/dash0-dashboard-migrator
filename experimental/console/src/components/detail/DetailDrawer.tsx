import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { DetailPanel } from "./DetailPanel";
import { displayTitle, type ReportItem } from "@/lib/report";

export function DetailDrawer({
  item,
  close,
}: {
  item?: ReportItem | undefined;
  close: () => void;
}) {
  return (
    <Sheet
      open={!!item}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="w-full p-0 sm:w-[min(1100px,95vw)] sm:max-w-none shadow-none">
        <SheetTitle className="sr-only">{item ? displayTitle(item) : "Item details"}</SheetTitle>
        <SheetDescription className="sr-only">
          Translation evidence and review decision
        </SheetDescription>
        {item && <DetailPanel key={item.id} item={item} className="detail-wide h-full pt-6" />}
      </SheetContent>
    </Sheet>
  );
}
