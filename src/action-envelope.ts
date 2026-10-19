import { RlmError } from './errors.ts';

/** Extract one balanced JSON object, tolerating presentation but refusing ambiguous envelopes. */
export function extractObject(output: string): string {
  let clean = output.trim();
  for (;;) {
    const reasoning = clean.search(/<think>/i);
    const object = clean.indexOf('{');
    if (reasoning < 0 || (object >= 0 && object < reasoning)) break;
    const closing = clean.slice(reasoning + 7).search(/<\/think>/i);
    if (closing < 0) throw new RlmError('invalid', 'Unterminated reasoning block');
    clean = clean.slice(0, reasoning) + clean.slice(reasoning + 7 + closing + 8);
  }
  const start = clean.indexOf('{');
  if (start < 0) throw new RlmError('invalid', 'Expected one JSON action object');
  if (/[[\]}]/.test(clean.slice(0, start))) throw new RlmError('invalid', 'Ambiguous action envelope');
  clean = clean.slice(start);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let stringStart = 0;
  const keys: Set<string>[] = [];
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        if (clean.slice(index + 1).trimStart().startsWith(':')) {
          const key: unknown = JSON.parse(clean.slice(stringStart, index + 1));
          const objectKeys = keys[keys.length - 1];
          if (objectKeys.has(String(key))) throw new RlmError('invalid', 'Ambiguous duplicate JSON key');
          objectKeys.add(String(key));
        }
      }
    } else if (char === '"') { quoted = true; stringStart = index; }
    else if (char === '{') { depth++; keys.push(new Set()); }
    else if (char === '}') {
      keys.pop();
      if (--depth !== 0) continue;
      const tail = clean.slice(index + 1).replace(/<think>[\s\S]*?<\/think>/gi, '');
      if (/<\/?think\b/i.test(tail)) throw new RlmError('invalid', 'Unterminated reasoning block');
      if (/[{}[\]]/.test(tail)) throw new RlmError('invalid', 'Ambiguous action envelope: return exactly one object');
      return clean.slice(0, index + 1);
    }
  }
  throw new RlmError('invalid', 'Unterminated JSON action object');
}
