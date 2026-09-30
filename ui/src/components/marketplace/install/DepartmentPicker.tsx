import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { projectsApi } from "@/api/projects";

export interface DepartmentPickerProps {
  companyId: string | null;
  value: string | null;
  onChange: (departmentId: string) => void;
}

/**
 * Department picker for snapshot installs.
 * Filters projects to type='department'. Shows error if none exist.
 * Disabled when companyId is null.
 */
export function DepartmentPicker({ companyId, value, onChange }: DepartmentPickerProps) {
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects", "list", companyId] as const,
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });

  const departments = projects.filter((p: { type?: string }) => p.type === "department");

  if (!companyId) {
    return (
      <p className="text-sm text-muted-foreground">Select a company first.</p>
    );
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading departments…</p>;
  }

  if (departments.length === 0) {
    return (
      <div className="text-sm text-destructive">
        No departments available — create a department first to install snapshot items.
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="install-department" className="text-sm font-medium block mb-1">
        Install to department
      </label>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger id="install-department">
          <SelectValue placeholder="Select a department" />
        </SelectTrigger>
        <SelectContent>
          {departments.map((d: { id: string; name: string }) => (
            <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
