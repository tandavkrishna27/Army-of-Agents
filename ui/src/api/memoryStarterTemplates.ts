export interface MemoryTemplateItem {
  title: string;
  content: string;
  category: string;
  tags?: string[];
}

export interface MemoryStarterTemplate {
  id: string;
  name: string;
  description: string;
  functionType: string;
  items: MemoryTemplateItem[];
}

export interface ApplyStarterTemplateResult {
  count: number;
  alreadyApplied: boolean;
}

export const memoryStarterTemplatesApi = {
  list: async (companyId: string): Promise<MemoryStarterTemplate[]> => {
    const res = await fetch(`/api/companies/${companyId}/memory/starter-templates`);
    if (!res.ok) throw new Error("Failed to fetch starter templates");
    return res.json() as Promise<MemoryStarterTemplate[]>;
  },

  apply: async (
    companyId: string,
    templateId: string,
    opts: { departmentId?: string | null } = {},
  ): Promise<ApplyStarterTemplateResult> => {
    const res = await fetch(
      `/api/companies/${companyId}/memory/starter-templates/${templateId}/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: opts.departmentId ?? null }),
      },
    );
    if (!res.ok) throw new Error("Failed to apply starter template");
    return res.json() as Promise<ApplyStarterTemplateResult>;
  },
};
