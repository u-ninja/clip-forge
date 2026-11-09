const megabytes = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 0,
});
const gigabytes = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "gigabyte",
  maximumFractionDigits: 1,
});
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3 ? gigabytes.format(bytes / 1024 ** 3) : megabytes.format(bytes / 1024 ** 2);
export const formatPercent = (fraction: number): string => percent.format(fraction);
export const formatTime = (ms: number): string => dateTime.format(new Date(ms));
