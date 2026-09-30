import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@armyofagents/shared";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

type CompanySelectionSource = "manual" | "route_sync" | "bootstrap";
type CompanySelectionOptions = { source?: CompanySelectionSource };

interface CompanyContextValue {
  companies: Company[];
  selectedCompanyId: string | null;
  selectedCompany: Company | null;
  selectionSource: CompanySelectionSource;
  loading: boolean;
  error: Error | null;
  setSelectedCompanyId: (companyId: string, options?: CompanySelectionOptions) => void;
  reloadCompanies: () => Promise<void>;
  createCompany: (data: {
    name: string;
    // Phase 2 Task 12: the founder wizard's org-first sequence creates the
    // tenant Organization (CreateOrganizationStep) before OrgStep calls this.
    // Optional because the value is threaded through from onboarding. In
    // cloud_auth it is always an explicit create-capable org id — the standalone
    // "create another company" surface (`/onboarding?new=1`) resolves it via
    // CreateAnotherCompany before calling createCompany, since the server 403s
    // an omitted id for a founder in >=2 orgs and never guesses. It is omitted
    // only on the self-hosted path, where resolveCompanyOrganizationId derives
    // DEFAULT_ORGANIZATION_ID. See OrgStep.tsx's submit().
    organizationId?: string;
    creationRequestId?: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => Promise<Company>;
}

const STORAGE_KEY = "aoa.selectedCompanyId";

export function resolveBootstrapCompanySelection(input: {
  companies: Company[];
  sidebarCompanies: Company[];
  selectedCompanyId: string | null;
  storedCompanyId: string | null;
}): string | null {
  if (input.companies.length === 0) return null;
  const selectableCompanies = input.sidebarCompanies.length > 0 ? input.sidebarCompanies : input.companies;
  if (input.selectedCompanyId && selectableCompanies.some((c) => c.id === input.selectedCompanyId)) {
    return input.selectedCompanyId;
  }
  if (input.storedCompanyId && selectableCompanies.some((c) => c.id === input.storedCompanyId)) {
    return input.storedCompanyId;
  }
  return selectableCompanies[0]?.id ?? null;
}

export function shouldClearStoredCompanySelection(input: {
  companies: Company[];
  isLoading: boolean;
  unauthorized: boolean;
}): boolean {
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);

  const companiesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: async () => {
      try {
        return { companies: await companiesApi.list(), unauthorized: false };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return { companies: [] as Company[], unauthorized: true };
        }
        throw err;
      }
    },
    retry: false,
  });
  const companies = companiesQuery.data?.companies ?? [];
  const unauthorized = companiesQuery.data?.unauthorized ?? false;
  const isLoading = companiesQuery.isLoading;
  const error = companiesQuery.error;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );

  // Auto-select company on bootstrap, validating stored id against loaded list
  useEffect(() => {
    if (isLoading) return;
    if (shouldClearStoredCompanySelection({ companies, isLoading, unauthorized })) {
      setSelectedCompanyIdState(null);
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const storedCompanyId = localStorage.getItem(STORAGE_KEY);
    const resolved = resolveBootstrapCompanySelection({
      companies,
      sidebarCompanies: sidebarCompanies ?? [],
      selectedCompanyId,
      storedCompanyId,
    });
    if (resolved !== selectedCompanyId) {
      setSelectedCompanyIdState(resolved);
      setSelectionSource("bootstrap");
      if (resolved) localStorage.setItem(STORAGE_KEY, resolved);
    }
  }, [companies, sidebarCompanies, isLoading, unauthorized, selectedCompanyId]);

  const setSelectedCompanyId = useCallback((companyId: string, options?: CompanySelectionOptions) => {
    setSelectedCompanyIdState(companyId);
    setSelectionSource(options?.source ?? "manual");
    localStorage.setItem(STORAGE_KEY, companyId);
  }, []);

  const reloadCompanies = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: { name: string; organizationId?: string; creationRequestId?: string; description?: string | null; budgetMonthlyCents?: number }) =>
      companiesApi.create(data),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(company.id);
    },
  });

  const createCompany = useCallback(
    async (data: { name: string; organizationId?: string; creationRequestId?: string; description?: string | null; budgetMonthlyCents?: number }) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  const value = useMemo(
    () => ({
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      loading: isLoading,
      error: error as Error | null,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    }),
    [
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      isLoading,
      error,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    ],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error("useCompany must be used within CompanyProvider");
  }
  return ctx;
}
