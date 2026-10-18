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
}
/** Model response with optional provider-reported usage, distinct from budget reservations. */
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
/** Supported bounded JSON actions. */
export type RlmAction =
  | { action: 'list'; filter: RlmFilter }
  | { action: 'search'; query: string; limit: number }
  | { action: 'get'; id: string; fields: string[] }
  | { action: 'history'; id: string; start: number; end: number }
  | { action: 'peek'; id: string; field: string; start: number; end: number }
  | { action: 'partition'; filter: RlmFilter; maxTokens: number }
  | { action: 'spawn'; subgoal: string; slice: RlmSlice }
  | { action: 'finish'; answer: string };
/** Recorded model step: reserving and checkpointing are separate crash-safe transitions. */
export interface RlmStep {
  prompt: string;
  reserved: number;
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
}
/** Durable run checkpoint stored through the SDK in the root call's registered field. */
export interface RlmState {
  version: 1;
  run: string;
  question: string;
  settings: RlmSettings;
  scope: RlmFilter;
  snapshot: RlmItem[];
  certificate: PmCompleteListCertificate;
  calls: RlmCall[];
  reserved_tokens: number;
}
/** Completed run summary. */
export interface RlmResult {
  run: string;
  answer: string;
  calls: number;
  reserved_tokens: number;
  tokens_in: number;
  tokens_out: number;
}
