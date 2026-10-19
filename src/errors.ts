import path, { win32 } from 'node:path';
/** Stable refusal codes usable by embedded loops and host commands. */
export type RlmErrorCode = 'budget' | 'depth' | 'calls' | 'scope' | 'invalid' | 'incomplete' | 'model' | 'busy' | 'replay';
/** Expected failure without raw transport errors, local paths or credentials. */
export class RlmError extends Error {
  /** Stable machine-readable refusal category. */
  readonly code: RlmErrorCode;
  /** Construct one typed operational refusal. */
  constructor(code: RlmErrorCode, message: string) {
    super(message);
    this.name = 'RlmError';
    this.code = code;
  }
}
/** Convert failed SDK reads into sanitized refusals while preserving existing typed failures. */
export async function sdkRead<T>(read: () => T | Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof RlmError) throw error;
    throw new RlmError('incomplete', 'Workspace data could not be read completely');
  }
}
/** Conservative byte-based token estimate: one token per UTF-8 byte, minimum one. */
export function estimateTokens(value: unknown): number {
  return Math.max(1, Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'));
}
/** Validate a finite bounded integer, rejecting coercion and unsafe arithmetic. */
export function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RlmError('invalid', 'Expected a bounded integer');
  return value;
}
/** Narrow untrusted JSON to a plain record. */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RlmError('invalid', 'Expected a JSON object');
  return value as Record<string, unknown>;
}
/** Validate nonempty text without embedding rejected data in diagnostics. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new RlmError('invalid', 'Expected nonempty text');
  return value;
}

/** Compare Windows path spellings after JSON escaping, separator and case normalization. */
function windowsPathText(value: string): string {
  return value.toLowerCase().replaceAll('\\\\', '/').replaceAll('\\', '/');
}

/** Reject local path and configured credential disclosure before writing new ledger material. */
export function assertLedgerPrivacy(value: unknown, workspace: string, keyEnv: string): void {
  const paths = /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(workspace) ? win32 : path;
  workspace = paths.resolve(workspace);
  const serialized = JSON.stringify(value);
  const secret = process.env[keyEnv];
  const grandparent = paths.dirname(paths.dirname(workspace));
  const needles = [workspace];
  if (paths.dirname(grandparent) !== grandparent) needles.push(grandparent + paths.sep);
  if (paths === win32) {
    const windowsText = windowsPathText(serialized);
    if (needles.some(needle => windowsText.includes(windowsPathText(needle)) || windowsText.includes(windowsPathText(JSON.stringify(needle).slice(1, -1))))) throw new RlmError('invalid', 'Ledger content contains local paths or configured credentials');
  }
  if (secret !== undefined && secret.length > 0) needles.push(secret);
  if (needles.some(needle => serialized.includes(needle) || serialized.includes(JSON.stringify(needle).slice(1, -1)))) throw new RlmError('invalid', 'Ledger content contains local paths or configured credentials');
}
