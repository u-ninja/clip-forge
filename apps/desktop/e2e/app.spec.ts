// Browser E2E (Chromium + mocked Tauri IPC). Not a native desktop test: see playwright.config.ts.
import { expect, test } from "@playwright/test";
import { installMockRuntime, setMock } from "./mock-runtime";

test.describe("with the desktop runtime (mocked IPC)", () => {
  test.beforeEach(async ({ page }) => {
    await installMockRuntime(page);
  });

  test("dashboard loads and shows the API online", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByTestId("service-API")).toContainText("Online");
    await expect(page.getByTestId("service-AI worker")).toContainText("Offline");
  });

  test("API connectivity status updates live", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("service-API")).toContainText("Online");
    await setMock(page, {
      api: {
        state: "failed",
        reason: "api crashed 3 times in 10 min; restart it manually",
        at: Date.now(),
      },
    });
    await expect(page.getByTestId("service-API")).toContainText("Failed");
    await expect(page.getByTestId("service-API")).toContainText("restart it manually");
  });

  test("sidebar navigation reaches every section", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const name of [
      "Content Studio",
      "Production Queue",
      "Diagnostics",
      "Settings",
      "Dashboard",
    ]) {
      await nav.getByRole("link", { name }).click();
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    }
  });

  test("settings opens and controls the on-demand worker", async ({ page }) => {
    await page.goto("/#/settings");
    const worker = page.getByTestId("service-AI worker");
    await expect(worker).toContainText("Offline");
    await expect(worker).toContainText("Starts on demand");
    await worker.getByRole("button", { name: "Start" }).click();
    await expect(worker).toContainText("Online");
    await worker.getByRole("button", { name: "Stop" }).click();
    await expect(worker).toContainText("Offline");
  });

  test("API unavailable state is handled", async ({ page }) => {
    await page.goto("/");
    await setMock(page, { api: { state: "stopped" } });
    await page.goto("/#/queue");
    await expect(page.getByRole("alert")).toContainText("Could not load jobs");
    await expect(page.getByRole("alert")).toContainText("not running");
    await expect(page.getByTestId("service-API")).toHaveCount(0); // queue page has no services card
  });

  test("a long-running job shows progress and then completes", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(page.getByText("No jobs yet.")).toBeVisible();
    await page.getByRole("button", { name: "Run self-test job" }).click();
    const row = page.getByTestId("job-row").first();
    await expect(row).toContainText("Running");
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect(row).toContainText("Done", { timeout: 15_000 });
  });

  test("running jobs can be cancelled", async ({ page }) => {
    await page.goto("/#/queue");
    await page.getByRole("button", { name: "Run self-test job" }).click();
    await page.getByRole("button", { name: /Cancel job/ }).click();
    await expect(page.getByTestId("job-row").first()).toContainText("Cancelled");
  });

  test("API errors are presented to the user", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(page.getByText("No jobs yet.")).toBeVisible();
    await setMock(page, {
      failNext: { status: 500, code: "INTERNAL", message: "Internal server error" },
    });
    await page.getByRole("button", { name: "Run self-test job" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not create the job");
    await expect(page.getByRole("alert")).toContainText("Internal server error");
  });

  test("diagnostics shows runtime data and exports a report", async ({ page }) => {
    await page.goto("/#/diagnostics");
    await expect(page.getByText("Apple M2")).toBeVisible();
    await expect(page.getByText(/free of 16/)).toBeVisible();
    await expect(page.getByText("request rejected")).toBeVisible();
    await page.getByRole("button", { name: "Export report" }).click();
    await expect(page.getByRole("status")).toContainText("diagnostics/report.json");
  });
});

test("without the desktop runtime the app explains what is missing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("needs the ClipForge desktop app");
});
