/** Provenance categories for every numeric metric emitted by the live harness and report. */
export const METRIC_PROVENANCE = {
  model_tokens: 'Provider-reported counters when present; conservative UTF-8 byte estimates otherwise. Per-response provenance was not retained, so totals are reported-or-estimated, not measured-only provider usage.',
  charged_tokens: 'Accounting sum of reported-or-estimated model usage, byte-estimated reads and worst-case pending reservations.',
  pending_tokens: 'Worst-case reservation estimates, not observed provider usage.',
  read_tokens: 'Conservative delivered-data UTF-8 byte estimates, not tokenizer measurements.',
  execution_counts: 'Exact observed request, call, child and refusal counts.',
  accuracy_and_baselines: 'Exact counts and ratios computed from tracker truth and recorded answers; displayed percentages are rounded.',
  timing: 'Measured wall-clock milliseconds; seconds per question are arithmetic means.',
  corpus: 'Exact item counts and computed UTF-8 serialized byte lengths.',
  limits: 'Configured context/output/token budgets, depth/call ceilings and temperature, not measured consumption.',
};

/** Invalidation notice retained with the historical cloud measurement and its reports. */
export const CLOUD_EVAL_INVALIDATION = "**Invalidated by an instruction conflict.** The recorded questions requested a bare integer or id while both arms required JSON, so correct bare answers could be scored wrong; these numbers are retained for history and require a new measurement before interpretation.";
