import { NavLink, Outlet } from "react-router";
import { NAV_ITEMS } from "@/app/navigation";
import { cn } from "@/lib/utils";

export function AppShell() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 py-5 text-sm font-semibold tracking-tight">ClipForge Local</div>
        <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
