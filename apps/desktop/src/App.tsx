import { HashRouter, Route, Routes } from "react-router";
import { NAV_ITEMS } from "@/app/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { DiagnosticsPage } from "@/features/diagnostics/DiagnosticsPage";
import { QueuePage } from "@/features/queue/QueuePage";
import { SectionPage } from "@/features/SectionPage";
import { SettingsPage } from "@/features/settings/SettingsPage";

const BUILT_PAGES: Readonly<Record<string, React.ReactElement>> = {
  "/queue": <QueuePage />,
  "/diagnostics": <DiagnosticsPage />,
  "/settings": <SettingsPage />,
};

// Hash routing: the bundled app is served from tauri:// with no server-side route fallback.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          {NAV_ITEMS.filter((n) => n.path !== "/").map((n) => (
            <Route key={n.path} path={n.path} element={BUILT_PAGES[n.path] ?? <SectionPage />} />
          ))}
          <Route path="*" element={<SectionPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
