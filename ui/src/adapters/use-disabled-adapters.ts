import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { setDisabledAdapterTypes } from "./disabled-store";
import { syncExternalAdapters } from "./registry";

export function useDisabledAdaptersSync(): Set<string> {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  if (adapters) {
    syncExternalAdapters(
      adapters
        .filter((adapter) => adapter.source === "external")
        .map((adapter) => ({
          type: adapter.type,
          label: adapter.label,
          disabled: adapter.disabled,
          overrideDisabled: adapter.overridePaused,
        })),
    );
  }

  useEffect(() => {
    if (!adapters) return;
    setDisabledAdapterTypes(
      adapters.filter((adapter) => adapter.disabled).map((adapter) => adapter.type),
    );
  }, [adapters]);

  return useMemo(
    () => new Set(adapters?.filter((adapter) => adapter.disabled).map((adapter) => adapter.type) ?? []),
    [adapters],
  );
}
