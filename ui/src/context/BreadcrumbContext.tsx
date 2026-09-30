import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useCompany } from "./CompanyContext.js";

export interface Breadcrumb {
  label: string;
  href?: string;
  departmentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  memoryFolderPath?: string | null;
}

interface BreadcrumbContextValue {
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  subtitle: string | null;
  setSubtitle: (sub: string | null) => void;
  entityColor: string | null;
  setEntityColor: (color: string | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function buildDocumentTitle(breadcrumbs: Breadcrumb[], companyName: string | null | undefined): string {
  const parts = [...breadcrumbs].reverse().map((b) => b.label).filter(Boolean);
  if (parts.length === 0 && !companyName) return "AoA";
  if (parts.length === 0) return `${companyName} · AoA`;
  if (!companyName) return `${parts.join(" · ")} · AoA`;
  return `${parts.join(" · ")} · ${companyName} · AoA`;
}

export function BreadcrumbProvider({ children, companyName }: { children: ReactNode; companyName?: string | null }) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
  const [subtitle, setSubtitleState] = useState<string | null>(null);
  const [entityColor, setEntityColorState] = useState<string | null>(null);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState(crumbs);
  }, []);

  const setSubtitle = useCallback((sub: string | null) => {
    setSubtitleState(sub);
  }, []);

  const setEntityColor = useCallback((color: string | null) => {
    setEntityColorState(color);
  }, []);

  useEffect(() => {
    document.title = buildDocumentTitle(breadcrumbs, companyName ?? null);
  }, [breadcrumbs, companyName]);

  return (
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs, subtitle, setSubtitle, entityColor, setEntityColor }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function BreadcrumbProviderWithCompany({ children }: { children: ReactNode }) {
  const { selectedCompany } = useCompany();
  return <BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</BreadcrumbProvider>;
}

export function useBreadcrumbs() {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error("useBreadcrumbs must be used within BreadcrumbProvider");
  }
  return ctx;
}
