import { HashRouter, Route, Routes } from "react-router";
import { NAV_ITEMS } from "@/app/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { SectionPage } from "@/features/SectionPage";

// Hash routing: the bundled app is served from tauri:// with no server-side route fallback.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          {NAV_ITEMS.filter((n) => n.path !== "/").map((n) => (
            <Route key={n.path} path={n.path} element={<SectionPage />} />
          ))}
          <Route path="*" element={<SectionPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
