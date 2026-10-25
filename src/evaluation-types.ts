import type { RlmModel, RlmSettings } from './types.ts';

/** Frozen public provenance and the digest of sorted full SDK item JSON. */
export interface RlmEvalSource { id: string; repository: string; revision: string; corpus_sha256: string }
/** Exact, format-neutral task; gold is never sent to either model arm. */
export interface RlmEvalQuestion { id: string; source: string; question: string; gold: string }
/** Reviewed manifest binding at least twenty tasks to verified public copies. */
export interface RlmEvalSuite { version: 1; id: string; sources: RlmEvalSource[]; questions: RlmEvalQuestion[] }
/** An interrupted request has unknown counters, never invented zero usage. */
export interface RlmEvalMetrics {
  correct: boolean; answer_sha256: string; calls: number | null; tokens_in: number | null; tokens_out: number | null;
  wall_ms: number | null; refusal: string; failed_requests: number | null; children: number;
}
/** One paired observation, with exact truncation accounting. */
export interface RlmEvalRow {
  id: string; source: string; visible_bytes: number; corpus_bytes: number;
  truncated: RlmEvalMetrics; recursive: RlmEvalMetrics;
}
/** Whole-suite denominator includes failures and interrupted requests. */
export interface RlmEvalSummary {
  correct: number; questions: number; accuracy: number; calls: number | null;
  tokens: number | null; wall_ms: number | null; children: number; failed_requests: number | null;
}
/** Native renderer payload; per-question observations are opt-in. */
export interface RlmEvalResult {
  evaluation: string; suite: string; model: string; mode: 'local' | 'stub'; status: 'complete' | 'skipped';
  reason: string; token_usage: 'reported_or_estimated_with_unknown_interrupted_usage';
  interpretation: 'exact_match_single_trial_no_advantage_claim';
  settings: Pick<RlmSettings, 'context_tokens' | 'output_tokens' | 'budget_tokens' | 'max_depth' | 'max_calls'>;
  sources: RlmEvalSource[]; summary: { truncated: RlmEvalSummary; recursive: RlmEvalSummary }; rows?: RlmEvalRow[];
}
/** Lease-protected durable transitions exposed for fault and interleaving validation. */
export type RlmEvalBoundary = 'leased' | 'created' | 'baseline_reserved' | 'baseline_settled' | 'recursive_reserved' | 'row_settled' | 'completed';
/** Evaluation receipts live in workspace; source copies are read-only and independently pinned. */
export interface RlmEvalOptions {
  workspace: string; sources: Record<string, string>; id: string; model: string; author?: string;
  endpoint?: string; mode?: 'local' | 'stub'; stub?: RlmModel; full?: boolean;
  settings?: Partial<Pick<RlmSettings, 'context_tokens' | 'output_tokens' | 'budget_tokens' | 'max_depth' | 'max_calls' | 'timeout_ms'>>;
  on_boundary?: (boundary: RlmEvalBoundary) => void | Promise<void>;
}
