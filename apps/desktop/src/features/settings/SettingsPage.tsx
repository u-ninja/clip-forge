import { PageHeader } from "@/components/layout/PageHeader";
import { ServicesCard } from "@/features/system/ServicesCard";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Services, models and storage" />
      <div className="grid max-w-2xl gap-4 p-8">
        <ServicesCard controls />
      </div>
    </>
  );
}
