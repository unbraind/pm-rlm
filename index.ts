/** Expose paired decompositions with fixed budgets and source-bound evidence receipts. */
export { reconcileRlm, parseReconcileArms, RlmReconcileError } from './src/reconcile.ts';
/** Public paired evidence declarations and compact results. */
export type { RlmReconcileArm, RlmReconcileOptions, RlmReconcileGroup, RlmReconcileResult } from './src/reconcile.ts';
import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Expose the certified token-budgeted environment for independent RLM loops. */
export { createRlmContext, RlmContext, partitionItems, parseFilter } from './src/environment.ts';
/** Expose bounded execution-time planning and typed partial receipts. */
export { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from './src/adaptive.ts';
/** Expose caller declarations, deterministic comparisons and compact results. */
export type { RlmQuestionPart, RlmStrategy, RlmStrategyComparison, RlmAdaptiveOptions, RlmAdaptiveResult, RlmAdaptiveComponent } from './src/adaptive.ts';
/** Expose durable recursive execution, recovery, replay and tree inspection. */
export { runRlm, resumeRlm, replayRlm, evidenceRlm, treeRlm, RlmEngine } from './src/engine.ts';
/** Expose the SDK ledger and logical reservation primitive. */
export { RlmLedger, reserveStep, promptDigest } from './src/ledger.ts';
/** Expose typed errors and conservative token estimation. */
export { RlmError, estimateTokens } from './src/errors.ts';
/** Expose the configurable Ollama and compatible HTTP transport. */
export { HttpModel } from './src/adapters.ts';
/** Expose settings resolution with flag precedence. */
export { readRlmSettings, writeRlmSettings } from './src/settings.ts';
/** Expose bounded evidence contracts and deterministic source witness creation. */
export { parseComponents, sourceWitness, RlmEvidenceError } from './src/evidence.ts';
/** Expose public environment, ledger and model contracts. */
export type { RlmEvidenceReport, RlmWitness, RlmAnswerComponent, RlmAggregate, RlmScalar, RlmItem, RlmFilter, RlmRead, RlmSlice, RlmFragment, RlmSettings, RlmModel, ModelRequest, ModelResponse, RlmAction, RlmState, RlmCall, RlmStep, RlmResult } from './src/types.ts';
/** Expose explicit run and environment creation parameters. */
export type { RlmRunOptions } from './src/engine.ts';
/** Expose independent environment options. */
export type { RlmContextOptions } from './src/environment.ts';
/** Activate native host commands and registered call fields. */
export default defineExtension({ name: 'pm-rlm', version: '2026.10.18', description: 'Recursive language models use pm as environment and ledger', activate: register });
/** Expose measured paired evaluation over frozen public tracker copies. */
export { evaluateRlm, parseEvalSuite, evalDigest, truncatedEvalPrompt, RlmEvalError } from './src/evaluation.ts';
/** Public suite, measurement and durable fault-boundary contracts. */
export type { RlmEvalSource, RlmEvalQuestion, RlmEvalSuite, RlmEvalMetrics, RlmEvalRow, RlmEvalSummary, RlmEvalResult, RlmEvalBoundary, RlmEvalOptions } from './src/evaluation-types.ts';
