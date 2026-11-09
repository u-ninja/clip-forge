import {
  Clapperboard,
  FolderOpen,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  type LucideIcon,
  PenLine,
  Settings,
  Stethoscope,
  Tv,
} from "lucide-react";

export interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard, description: "Production overview" },
  { path: "/content", label: "Content Studio", icon: PenLine, description: "Ideas and scripts" },
  {
    path: "/clips",
    label: "Clip Studio",
    icon: Clapperboard,
    description: "Clip editing and shorts",
  },
  { path: "/channels", label: "Channels", icon: Tv, description: "Channels and profiles" },
  { path: "/queue", label: "Production Queue", icon: ListChecks, description: "Jobs and progress" },
  {
    path: "/media",
    label: "Media Library",
    icon: FolderOpen,
    description: "Sources, assets and rights",
  },
  {
    path: "/templates",
    label: "Templates",
    icon: LayoutTemplate,
    description: "Video and caption templates",
  },
  {
    path: "/diagnostics",
    label: "Diagnostics",
    icon: Stethoscope,
    description: "Runtime health and support report",
  },
  {
    path: "/settings",
    label: "Settings",
    icon: Settings,
    description: "Services, models and storage",
  },
];
