// Worker-thread fixture for the concurrent-claim test: claims jobs on its own connection until none remain.
import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "@clipforge/database";
import { JobStore } from "./store.js";

const { path, owner } = workerData as { path: string; owner: string };
const handle = openDatabase(path);
const store = new JobStore(handle.db, { maxQueued: 10_000 });
const claimed: string[] = [];
for (;;) {
  const job = store.claim(owner, 60_000, 1_000);
  if (!job) break;
  claimed.push(job.id);
  store.succeed(job.id, owner, undefined);
}
handle.close();
parentPort?.postMessage(claimed);
