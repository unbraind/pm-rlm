import { certifyCompleteListResult, getHistoryPath, PmClient, readHistoryEntries, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import { aggregateItems } from './aggregates.ts';
import { estimateTokens, integer, record, RlmError, sdkRead, text } from './errors.ts';
import type { RlmAggregate, RlmFilter, RlmItem, RlmRead, RlmSlice } from './types.ts';
import type { PmCompleteListCertificate } from '@unbrained/pm-cli/sdk';

/** Validate supported predicates; silently ignored filters would widen private scope. */
export function parseFilter(value: unknown): RlmFilter {
  const input = record(value);
  const result: RlmFilter = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key === 'ids') {
      if (!Array.isArray(entry)) throw new RlmError('invalid', 'Scope ids must be an array');
      result.ids = entry.map(text);
    } else if (['type', 'status', 'parent', 'tag', 'text'].includes(key)) {
      result[key as 'type'] = text(entry);
    } else throw new RlmError('invalid', 'Unknown scope predicate');
  }
  return result;
}
/** Match exact typed predicates and case-insensitive full-item text. */
export function matches(item: RlmItem, filter: RlmFilter): boolean {
  return (filter.type === undefined || item.type === filter.type)
    && (filter.status === undefined || item.status === filter.status)
    && (filter.parent === undefined || item.parent === filter.parent)
    && (filter.tag === undefined || item.tags.includes(filter.tag))
    && (filter.ids === undefined || filter.ids.includes(item.id))
    && (filter.text === undefined || JSON.stringify(item).toLowerCase().includes(filter.text.toLowerCase()));
}
/** Split lossless item JSON into packed fragments that never exceed the slice budget. */
export function partitionItems(items: readonly RlmItem[], maxTokens: number): RlmSlice[] {
  integer(maxTokens, 1);
  const slices: RlmSlice[] = [];
  let fragments: RlmSlice['fragments'] = [];
  for (const item of items) {
    const source = JSON.stringify(item);
    let start = 0;
    while (start < source.length) {
      let low = 0;
      let high = source.length - start;
      while (low < high) {
        const size = Math.ceil((low + high) / 2);
        const candidate = { id: item.id, start, end: start + size, text: source.slice(start, start + size) };
        if (estimateTokens([...fragments, candidate]) <= maxTokens) low = size;
        else high = size - 1;
      }
      if (low === 0) {
        if (fragments.length === 0) throw new RlmError('budget', 'Slice budget cannot hold one fragment');
        slices.push({ fragments, estimated_tokens: estimateTokens(fragments) });
        fragments = [];
      } else {
        fragments.push({ id: item.id, start, end: start + low, text: source.slice(start, start + low) });
        start += low;
      }
    }
  }
  if (fragments.length > 0) slices.push({ fragments, estimated_tokens: estimateTokens(fragments) });
  return slices;
}
/** Options for one independent SDK environment with a mutable remaining budget. */
export interface RlmContextOptions {
  workspace: string;
  scope?: RlmFilter;
  budget: number;
}
/** Certified, scoped environment for third-party recursive loops. */
export class RlmContext {
  private readonly workspace: string;
  private readonly items: readonly RlmItem[];
  private readonly certificate: PmCompleteListCertificate;
  remaining: number;
  /** Retain a certified snapshot and charge only successful reads. */
  constructor(workspace: string, items: readonly RlmItem[], certificate: PmCompleteListCertificate, remaining: number) {
    integer(remaining, 0);
    this.workspace = workspace; this.items = structuredClone(items); this.certificate = structuredClone(certificate); this.remaining = remaining;
  }
  /** Charge the entire delivered representation before revealing it. */
  private deliver<T>(data: T): RlmRead<T> {
    const estimated_tokens = estimateTokens(data);
    if (estimated_tokens > this.remaining) throw new RlmError('budget', 'Read exceeds remaining token budget');
    this.remaining -= estimated_tokens;
    return { data: structuredClone(data), estimated_tokens, complete_list: structuredClone(this.certificate) };
  }
  /** Resolve an id only inside the caller's immutable scope. */
  private item(id: string): RlmItem {
    const found = this.items.find(item => item.id === id);
    if (found === undefined) throw new RlmError('scope', 'Item is outside the certified scope');
    return found;
  }
  /** List every matching full item, failing instead of truncating for budget. */
  list(filter: RlmFilter = {}): RlmRead<RlmItem[]> {
    return this.deliver(this.items.filter(item => matches(item, parseFilter(filter))));
  }
  /** Search the complete scoped snapshot with an explicit result limit. */
  search(query: string, limit: number): RlmRead<RlmItem[]> {
    integer(limit, 1);
    text(query);
    return this.deliver(this.items.filter(item => matches(item, { text: query })).slice(0, limit));
  }
  /** Select named fields from a full scoped item; identity is always present. */
  get(id: string, fields: string[] = []): RlmRead<Record<string, unknown>> {
    const item = this.item(id);
    const selected: Record<string, unknown> = { id: item.id };
    if (fields.length === 0) return this.deliver({ ...item });
    for (const field of fields) {
      if (!Object.hasOwn(item, field)) throw new RlmError('invalid', 'Unknown item field');
      selected[field] = item[field];
    }
    return this.deliver(selected);
  }
  /** Read and verify append-only SDK history, returning the requested half-open version range. */
  async history(id: string, range: { start: number; end: number }): Promise<RlmRead<unknown[]>> {
    const item = this.item(id);
    integer(range.start, 0); integer(range.end, range.start);
    const entries = await sdkRead(async () => {
      const history = await readHistoryEntries(getHistoryPath(this.workspace, id), id);
      if (history.length === 0 || !verifyHistoryEntries(history).ok) throw new RlmError('incomplete', 'History chain is missing or invalid');
      return history;
    });
    return this.deliver(entries.filter(entry => entry.ts <= item.updated_at).slice(range.start, range.end));
  }
  /** Inspect a bounded UTF-16 substring of text or a serialized structured field. */
  peek(id: string, field: string, start: number, end: number): RlmRead<string> {
    integer(start, 0); integer(end, start);
    const item = this.item(id);
    if (!Object.hasOwn(item, field)) throw new RlmError('invalid', 'Unknown item field');
    const value = item[field];
    return this.deliver((typeof value === 'string' ? value : JSON.stringify(value)).slice(start, end));
  }
  /** Execute a typed aggregate over this frozen scope and charge the entire result. */
  aggregate(action: RlmAggregate): RlmRead<ReturnType<typeof aggregateItems>> {
    return this.deliver(aggregateItems(this.items, action));
  }
  /** Return lossless packed slices; the whole partition response is also charged. */
  partition(filter: RlmFilter, maxTokens: number): RlmRead<RlmSlice[]> {
    return this.deliver(partitionItems(this.items.filter(item => matches(item, parseFilter(filter))), maxTokens));
  }
}
/** Create a complete SDK snapshot, exclude execution ledger rows, and intersect its scope. */
export async function createRlmContext(options: RlmContextOptions): Promise<RlmContext> {
  const corpus = await readCorpus(options.workspace);
  return new RlmContext(options.workspace, corpus.items.filter(item => matches(item, parseFilter(options.scope ?? {}))), corpus.complete_list, options.budget);
}
/** Read all statuses and fields with explicit complete-list certification. */
export async function readCorpus(workspace: string): Promise<{ items: RlmItem[]; complete_list: PmCompleteListCertificate }> {
  const result = await sdkRead(async () => certifyCompleteListResult(await new PmClient({ pmRoot: workspace, noExtensions: true }).listAllComplete({ includeBody: true })));
  return { items: result.items.filter(item => !item.tags.includes('rlm:call') && !item.tags.includes('rlm:question')).sort((a, b) => a.id.localeCompare(b.id)), complete_list: result.complete_list };
}
