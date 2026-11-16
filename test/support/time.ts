/** Validate watchdog scaling before any test worker starts. Product budgets remain unscaled. */
const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
if (!Number.isFinite(scale) || scale <= 0) throw new Error("PM_TEST_TIME_SCALE must be finite and positive");
/** Return an integer harness deadline, suitable for spawnSync. */
export function testTime(milliseconds: number): number { return Math.ceil(milliseconds * scale); }
