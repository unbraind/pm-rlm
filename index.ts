/** Expose paired decompositions with fixed budgets and source-bound evidence receipts. */
export { reconcileRlm, parseReconcileArms, RlmReconcileError } from './src/reconcile.ts';
/** Public paired evidence declarations and compact results. */
export type { RlmReconcileArm, RlmReconcileOptions, RlmReconcileGroup, RlmReconcileResult } from './src/reconcile.ts';
import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Targeted evidence repair with durable native recovery and bounded agent receipts. */
export { repairRlm, resumeRepairRlm, compactRepairResult } from './src/repair.ts';
/** Strict producer/consumer contracts and explicit dependency declarations. */
export { REPAIR_SCHEMA, RlmRepairError, parseRepairRequest, parseRepairCheckpoint } from './src/repair-contract.ts';
/** Public repair declarations and execution results. */
export type { RlmRepairPart, RlmRepairRequest, RlmRepairOptions, RlmRepairResult, RlmRepairComponent, RlmRepairSkipped, RlmRepairCheckpoint } from './src/repair-contract.ts';
/** Expose the certified token-budgeted environment for independent RLM loops. */
export { createRlmContext, RlmContext, partitionItems, parseFilter } from './src/environment.ts';
/** Expose bounded execution-time planning and typed partial receipts. */
export { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from './src/adaptive.ts';
/** Expose caller declarations, deterministic comparisons and compact results. */
export type { RlmQuestionPart, RlmStrategy, RlmStrategyComparison, RlmAdaptiveOptions, RlmAdaptiveResult, RlmAdaptiveComponent } from './src/adaptive.ts';
/** Expose durable recursive execution, recovery, replay and tree inspection. */
export { prepareRlmRun, runRlm, resumeRlm, replayRlm, evidenceRlm, treeRlm, RlmEngine } from './src/engine.ts';
/** Expose the SDK ledger and logical reservation primitive. */
export { RlmLedger, reserveStep, promptDigest } from './src/ledger.ts';
/** Expose crash-recovery tuning for ledger mutations blocked by dead previous writers. */
export type { RlmLedgerOptions } from './src/ledger.ts';
/** Expose typed errors and conservative token estimation. */
export { RlmError, RlmTranscriptError, estimateTokens } from './src/errors.ts';
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

/** Explicit cross-run subanswer selection, verification and typed refusals. */
export { reuseRlm, compactReuseResult } from './src/reuse.ts';
/** Reuse request and compact result contracts. */
export type { RlmReuseOptions, RlmReuseResult, RlmReuseSkipped } from './src/reuse.ts';
/** Immutable caller policy and original provenance identities. */
export type { RlmReuseDimension, RlmReuseIdentity, RlmReuseSelection, RlmReuseProvenance } from './src/reuse-contract.ts';
/** Strict reuse boundary schema and machine-actionable refusal. */
export { REUSE_SCHEMA, RlmReuseError, RlmReuseConflict } from './src/reuse-contract.ts';

/** Read-only executable final-answer invariants over a certified immutable scope. */
export { verifyRlmAnswer } from './src/answer-invariants.ts';
/** Versioned declarations and actionable refusal shared by SDK and CLI. */
export { ANSWER_INVARIANT_SCHEMA, parseAnswerContract, RlmInvariantError } from './src/answer-contract.ts';
/** Public answer contracts, check results and operational source selection. */
export type { RlmAnswerContract, RlmAnswerInvariant, RlmAnswerField, RlmAnswerScalar, RlmCountInvariant, RlmMembershipInvariant, RlmEqualityInvariant, RlmInvariantResult, RlmAnswerReport } from './src/answer-contract.ts';
/** Read-only source selection for final-answer verification. */
export type { RlmVerifyAnswerOptions } from './src/answer-invariants.ts';
