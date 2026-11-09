/**
 * MOCK DATA — placeholder figures for the Phase 1 dashboard only.
 * Nothing here is read from the API or database. Replace with API queries in Phase 2;
 * do not import this module from anywhere except the dashboard.
 */
import type { JobStatus } from "@clipforge/shared";

export const mockSummary = {
  activeChannels: 3,
  weeklyTarget: { completed: 7, target: 12 },
  jobsInProgress: 4,
  publishedVideos: 58,
} as const;

export interface MockActivity {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly stage: string;
  readonly status: JobStatus;
  readonly at: Date;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export const mockActivity: readonly MockActivity[] = [
  {
    id: "a1",
    title: "Why bridges sing in the wind",
    channel: "Everyday Physics",
    stage: "Rendering",
    status: "running",
    at: minutesAgo(6),
  },
  {
    id: "a2",
    title: "Top 5 forgotten 90s gadgets",
    channel: "Retro Tech",
    stage: "Voiceover",
    status: "queued",
    at: minutesAgo(22),
  },
  {
    id: "a3",
    title: "Sourdough in 60 seconds",
    channel: "Kitchen Shorts",
    stage: "Publishing",
    status: "succeeded",
    at: minutesAgo(95),
  },
  {
    id: "a4",
    title: "How GPS actually works",
    channel: "Everyday Physics",
    stage: "Scripting",
    status: "failed",
    at: minutesAgo(180),
  },
];

export const mockPipeline: readonly { readonly stage: string; readonly count: number }[] = [
  { stage: "Scripting", count: 3 },
  { stage: "Voiceover", count: 2 },
  { stage: "Rendering", count: 1 },
  { stage: "Review", count: 2 },
  { stage: "Publishing", count: 0 },
];
