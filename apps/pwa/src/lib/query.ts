import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient } from "@tanstack/react-query";

/**
 * Reads and writes are local-first. A phone app that shows a spinner because
 * the network is slow feels broken; one that shows the last known list
 * immediately and reconciles afterwards feels solid.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data is shown instantly and refreshed in the background.
      staleTime: 30_000,
      gcTime: 7 * 24 * 60 * 60 * 1000,
      // Mobile apps get foregrounded constantly; refetching on every focus
      // would fight with the cache for no benefit.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        // Never retry auth/validation failures — only transient ones.
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      networkMode: "offlineFirst",
    },
    mutations: { networkMode: "offlineFirst" },
  },
});

export const persister = createSyncStoragePersister({
  storage: typeof window === "undefined" ? undefined : window.localStorage,
  key: "portal.query-cache",
  throttleTime: 1_000,
});
