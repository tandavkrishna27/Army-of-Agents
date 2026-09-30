import { useContext } from "react";
import { InstallToastContext } from "./ToastProvider";

// No-op fallback for modals rendered outside the provider (test-only path).
const NOOP = {
  show: () => "",
  update: () => {},
  trackOperation: () => {},
  dismiss: () => {},
};

export function useInstallToast() {
  return useContext(InstallToastContext) ?? NOOP;
}
