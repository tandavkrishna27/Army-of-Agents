import React, { StrictMode } from "react";
import ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { CompanyProvider } from "./context/CompanyContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { BreadcrumbProviderWithCompany } from "./context/BreadcrumbContext";
import { SidebarProvider } from "./context/SidebarContext";
import { DialogProvider } from "./context/DialogContext";
import { ToastProvider } from "./context/ToastContext";
import { ThemeProvider } from "./context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastViewport } from "@/components/ToastViewport";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { UnsavedChangesProvider } from "./context/UnsavedChangesProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initPluginBridge } from "./plugins/bridge-init";
import { runStorageMigrations } from "./lib/storage-migrations";
import "@mdxeditor/editor/style.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./index.css";

// Migrate legacy Paperclip localStorage keys to AoA names before any
// context provider reads from localStorage.
runStorageMigrations();

// Initialize plugin bridge before React renders
initPluginBridge(React, ReactDOM);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

// Inner shell rendered as the data router's single catch-all element. The
// existing <Routes>/<Route> tree in <App/> rides along unchanged; mounting via
// createBrowserRouter (instead of <BrowserRouter>) is what unlocks the app-wide
// useBlocker inside UnsavedChangesProvider (validated by the /browse spike).
function RouterShell() {
  return (
    <TooltipProvider>
      <BreadcrumbProviderWithCompany>
        <SidebarProvider>
          <DialogProvider>
            <InstallToastProvider>
              <UnsavedChangesProvider>
                <App />
                <ToastViewport />
              </UnsavedChangesProvider>
            </InstallToastProvider>
          </DialogProvider>
        </SidebarProvider>
      </BreadcrumbProviderWithCompany>
    </TooltipProvider>
  );
}

// INTENTIONAL single catch-all: the whole app rides as a descendant <Routes>
// tree inside <App/>, so the lone UnsavedChangesProvider/useBlocker in
// <RouterShell/> is always mounted and sees every navigation. Do NOT add sibling
// top-level data routes or migrate App's <Routes> into this config without moving
// the guard accordingly — a route outside this splat would bypass the blocker.
const router = createBrowserRouter([{ path: "*", element: <RouterShell /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <CompanyProvider>
            <ToastProvider>
              <LiveUpdatesProvider>
                <RouterProvider router={router} />
              </LiveUpdatesProvider>
            </ToastProvider>
          </CompanyProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
