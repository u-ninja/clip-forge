import { useLocation } from "react-router";
import { NAV_ITEMS } from "@/app/navigation";
import { PageHeader } from "@/components/layout/PageHeader";

/** Shared page for sections whose features land in later phases (see docs/ROADMAP.md). */
export function SectionPage() {
  const { pathname } = useLocation();
  const item = NAV_ITEMS.find((n) => n.path === pathname);
  return (
    <>
      <PageHeader title={item?.label ?? "Not found"} description={item?.description} />
      <p className="p-8 text-sm text-muted-foreground">
        Not built yet. See docs/ROADMAP.md for the phase that adds this section.
      </p>
    </>
  );
}
