import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/context/CompanyContext";

export interface CompanyPickerProps {
  value: string | null;
  onChange: (companyId: string) => void;
  /** Hide the picker entirely if true (caller decides; defaults to auto-hide on 1 company). */
  forceHidden?: boolean;
}

/**
 * Company picker for marketplace install.
 * Auto-hides when user has 1 active company (the only option is implicit).
 * Shows dropdown when 2+ active companies.
 */
export function CompanyPicker({ value, onChange, forceHidden }: CompanyPickerProps) {
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");

  if (forceHidden || activeCompanies.length <= 1) return null;

  return (
    <div>
      <label htmlFor="install-company" className="text-sm font-medium block mb-1">
        Install to company
      </label>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger id="install-company">
          <SelectValue placeholder="Select a company" />
        </SelectTrigger>
        <SelectContent>
          {activeCompanies.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
