import type { RlmReuseIdentity, RlmReuseProvenance, RlmReuseSelection } from './reuse-contract.ts';
import type { RlmErrorCode } from './errors.ts';
import type { ListedItem, PmCompleteListCertificate } from '@unbrained/pm-cli/sdk';

/** Fully materialized SDK item, including its body when available. */
export type RlmItem = ListedItem;
/** Narrowing predicates intersected with the caller's immutable scope. */
export interface RlmFilter {
  type?: string;
  status?: string;
  parent?: string;
  tag?: string;
  text?: string;
  ids?: string[];
}
/** A complete read with a charged conservative token estimate. */
export interface RlmRead<T> {
  data: T;
  estimated_tokens: number;
  complete_list: PmCompleteListCertificate;
}
/** Lossless fragment of an item's JSON representation; offsets are UTF-16 positions. */
export interface RlmFragment {
  id: string;
  start: number;
  end: number;
  text: string;
}
/** A partition whose fragments' serialized form fits its advertised token estimate. */
export interface RlmSlice {
  fragments: RlmFragment[];
  estimated_tokens: number;
}
/** Durable execution limits and transport configuration; credentials stay in the environment. */
export interface RlmSettings {
  model: string;
  adapter: 'ollama' | 'openai';
  endpoint: string;
  key_env: string;
  max_depth: number;
  max_calls: number;
  budget_tokens: number;
  output_tokens: number;
  context_tokens: number;
  timeout_ms: number;
}
/** Immutable input handed to a model adapter. */
export interface ModelRequest {
  prompt: string;
  max_output_tokens: number;
  context_tokens: number;
  response_kind?: 'action' | 'answer';
  parser_version?: 1 | 2 | 3;
}
/** Model response counters use provider reports when available and conservative estimates otherwise. */
export interface ModelResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
}
/** Third-party model transport; deterministic implementations belong in tests. */
export interface RlmModel {
  name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
/** Scalar grouping values; absent values are represented as null. */
export type RlmScalar = string | number | boolean | null;
/** Deterministic aggregate requests; expression syntax is validated without executing code. */
export type RlmAggregate =
  | { action: 'count'; filter: RlmFilter }
  | { action: 'sum'; filter: RlmFilter; field_expr: string }
  | { action: 'distinct' | 'group_count'; filter: RlmFilter; field: string }
  | { action: 'argmax' | 'argmin'; filter: RlmFilter; numeric_expr: string };
/** Bounded exact source excerpt, hashed together with its identity and offsets. */
export interface RlmWitness { id: string; start: number; end: number; text: string; digest: string }
/** Component answer; unavailable evidence is represented without an answer or witnesses. */
export interface RlmAnswerComponent {
  component: string;
  status: 'supported' | 'unsupported' | 'unknown';
  answer: string;
  reason: string;
  witnesses: { step: number; digest: string }[];
}
/** Supported bounded JSON actions. */
export type RlmAction =
  | RlmAggregate
  | { action: 'witness'; id: string; start: number; end: number }
  | { action: 'answer'; components: RlmAnswerComponent[] }
  | { action: 'list'; filter: RlmFilter }
  | { action: 'search'; query: string; limit: number }
  | { action: 'get'; id: string; fields: string[] }
  | { action: 'history'; id: string; start: number; end: number }
  | { action: 'peek'; id: string; field: string; start: number; end: number }
  | { action: 'partition'; filter: RlmFilter; maxTokens: number }
  | { action: 'spawn'; subgoal: string; slice: RlmSlice | { partition_step: number; index: number } }
  | { action: 'finish'; answer: string };
/** Recorded model step: reserving and checkpointing are separate crash-safe transitions. */
export interface RlmStep {
  prompt: string;
  reserved: number;
  settled?: true;
  response?: ModelResponse;
  observation?: unknown;
}
/** One logical call with a deterministic id, digest and replayable transcript. */
export interface RlmCall {
  id: string;
  parent?: string;
  depth: number;
  subgoal: string;
  slice: RlmSlice;
  digest: string;
  steps: RlmStep[];
  result?: string;
  failure?: { code: RlmErrorCode; reason?: string; remedy?: string };
  /** Typed completion-hook refusal after a durable result; later result reuse does not repeat the hook. */
  completion_refusal?: { code: RlmErrorCode; reason: string; remedy?: string };
}
/** Hydrated run checkpoint; v2 storage manifests resolve immutable blobs into this compatible shape. */
export interface RlmState {
  version: 1;
  /** Explicit caller authorization; absent on legacy runs that cannot be reused. */
  reuse_identity?: RlmReuseIdentity;
  /** Selected original answer; transcript and usage stay in the original ledger. */
  reuse?: RlmReuseProvenance;
  /** Durable explicit intent; recovery revalidates before satisfying this root. */
  reuse_selection?: RlmReuseSelection;
  /** Missing/v1 keeps JSON-key ordering; v2 uses scalar type then value ordering. */
  aggregate_version?: 1 | 2;
  parser_version?: 1 | 2 | 3;
  run: string;
  question: string;
  /** Immutable evidence contract; absent for legacy execution-only runs. */
  components?: string[];
  settings: RlmSettings;
  scope: RlmFilter;
  snapshot: RlmItem[];
  /** Restrict paired runs to their captured corpus, refusing live history reads. */
  snapshot_only?: true;
  certificate: PmCompleteListCertificate;
  calls: RlmCall[];
  reserved_tokens: number;
}
/** Completed run summary: exact call count, accounting charge and reported-or-estimated model counters. */
export interface RlmResult {
  token_usage: 'reported_or_estimated';
  /** Present only for explicit cross-run reuse, with zero newly charged usage. */
  reuse?: RlmReuseProvenance;
  run: string;
  answer: string;
  /** Verified per-component evidence, absent on execution-only runs. */
  components?: RlmAnswerComponent[];
  calls: number;
  reserved_tokens: number;
  tokens_in: number;
  tokens_out: number;
}

/** Compact verified coverage report; source excerpts stay in the durable transcript. */
export interface RlmEvidenceReport {
  run: string;
  verified: true;
  total: number;
  supported: number;
  unsupported: number;
  unknown: number;
  components: RlmAnswerComponent[];
}
