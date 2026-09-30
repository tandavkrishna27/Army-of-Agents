import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ActivitySection } from "@/components/settings/sections/ActivitySection";

export function CompanyActivityPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Activity" }]); }, [setBreadcrumbs]);
  return <ActivitySection />;
}
