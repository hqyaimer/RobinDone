import { useRobinDoneStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useRobinDoneStoreWithDefault((state) => state.interfaceMode === "office", false);
}
