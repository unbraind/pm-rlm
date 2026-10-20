import { ACTION_SCHEMA, ANSWER_SCHEMA, COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ANSWER_WIRE_SCHEMA, compatibleAction } from './action-schema.ts';
import { estimateTokens, integer, record, RlmError, text } from './errors.ts';
import type { ModelRequest, ModelResponse, RlmModel, RlmSettings } from './types.ts';

/** HTTP model adapter; only a key's environment variable name is part of its configuration. */
export class HttpModel implements RlmModel {
  /** Stable model identity recorded in every call. */
  readonly name: string;
  private readonly config: RlmSettings;
  /** Select the configured wire protocol without resolving or storing credentials. */
  constructor(config: RlmSettings) { this.config = config; this.name = config.model; }
  /** Perform one bounded, nonstreaming inference and sanitize all transport failures. */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const config = this.config;
    const compatible = config.adapter === 'openai';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (compatible) {
      const key = process.env[config.key_env];
      if (!key) throw new RlmError('model', 'Model credential environment variable is unset');
      headers.Authorization = `Bearer ${key}`;
    }
    const answer = request.response_kind === 'answer';
    const legacy = request.parser_version !== undefined && request.parser_version < 3;
    const schema = answer ? ANSWER_SCHEMA : ACTION_SCHEMA;
    const body = compatible
      ? { model: config.model, messages: [{ role: 'user', content: request.prompt }], max_tokens: request.max_output_tokens, temperature: 0, stream: false, ...(legacy ? {} : { response_format: { type: 'json_schema', json_schema: { name: answer ? 'answer' : 'action', strict: true, schema: answer ? COMPATIBLE_ANSWER_WIRE_SCHEMA : COMPATIBLE_ACTION_WIRE_SCHEMA } } }) }
      : { model: config.model, prompt: request.prompt, stream: false, format: legacy ? 'json' : schema, think: false, options: { temperature: 0, num_predict: request.max_output_tokens, num_ctx: request.context_tokens } };
    try {
      const response = await fetch(`${config.endpoint.replace(/\/$/, '')}${compatible ? '/chat/completions' : '/api/generate'}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeout_ms), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RlmError('model', 'Model endpoint refused the request');
      }
      const limit = 8 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body === null) throw new RlmError('model', 'Model response body is missing');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new RlmError('model', 'Model response exceeds byte allowance');
        chunks.push(chunk);
      }
      const result = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      let output: string;
      let inputTokens: unknown;
      let outputTokens: unknown;
      if (compatible) {
        if (!Array.isArray(result.choices) || result.choices.length === 0) throw new RlmError('model', 'Model response has no choices');
        output = text(record(record(result.choices[0]).message).content);
        const usage = result.usage === undefined ? {} : record(result.usage);
        inputTokens = usage.prompt_tokens; outputTokens = usage.completion_tokens;
      } else {
        output = text(result.response);
        inputTokens = result.prompt_eval_count; outputTokens = result.eval_count;
      }
      if (estimateTokens(output) > request.max_output_tokens * 16) throw new RlmError('model', 'Model output exceeds transport allowance');
      return { text: compatible && !answer && !legacy ? compatibleAction(output) : output, tokens_in: inputTokens === undefined ? estimateTokens(request.prompt) : integer(inputTokens, 0), tokens_out: outputTokens === undefined ? estimateTokens(output) : integer(outputTokens, 0) };
    } catch (error) { if (error instanceof RlmError) throw error; throw new RlmError('model', 'Model request failed; inspect endpoint availability and configuration'); }
  }
}
