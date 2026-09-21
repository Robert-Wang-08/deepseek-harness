/**
 * The escalation vocabulary and choreography shared by every sandbox-enforcing
 * tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
 * strictly-wider ladder, the argument-pairing validation, the model-facing
 * denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
 * sequence that resolves a `sandbox_permissions` request through a
 * user-approval channel BEFORE anything executes. One home keeps the two
 * families' approval ordering and verbatim error texts from drifting apart.
 *
 * The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
 * not the approval service type: the tool layer — which owns the agent, the
 * call id, and the tool name — closes over `ctx.approval.request(...)` and
 * hands the closure down, so this package never depends on the approval or
 * agent packages.
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SandboxMode } from './index.ts'

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
 * whenever the mounted capability confines: cutting the enum down to the modes
 * wider than the composition's DEFAULT would strand a session whose effective
 * mode sits below it (a `danger-full-access` default would advertise nothing
 * while a narrower-switched session stays confined with no lever).
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * A normalized escalation request: both fields present with text, or the ask
 * is not an ask at all (the normalizer returns `undefined`).
 */
export interface NormalizedEscalationArgs {
  /** The requested target mode (the schema enum pins the closed target vocabulary). */
  sandbox_permissions: string
  /** The caller's non-empty one-sentence reason. */
  justification: string
}

/**
 * Normalize one raw escalation argument pair and validate the pairing a tool
 * schema cannot express: a field that is absent OR blank counts as absent, so a
 * transport that serializes "no escalation" as two empty strings reads exactly
 * like a caller that omitted both — an ordinary call is never turned into a
 * malformed ask by the caller's own empty-string defaults. A request that
 * survives normalization must be whole: `sandbox_permissions` and
 * `justification` travel together — an approval prompt without a reason, or a
 * reason driving nothing, is a malformed ask — and the justification must be a
 * non-empty sentence. Nothing here invents a request, widens a mode, or drops a
 * real one: normalization can only empty a field the caller left blank.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
 * @param justification - the raw `justification` argument, if given.
 * @returns the normalized pair, or `undefined` when neither field carries text.
 */
export function normalizeEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): NormalizedEscalationArgs | undefined {
  const permission = sandboxPermissions !== undefined && sandboxPermissions.trim().length > 0 ? sandboxPermissions : undefined
  const reason = justification !== undefined && justification.trim().length > 0 ? justification : undefined
  if (reason !== undefined && permission === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (permission !== undefined) {
    if (justification === undefined) {
      throw new Error('invalid escalation: sandbox_permissions requires a justification')
    }
    if (reason === undefined) {
      throw new Error('invalid justification: expected a non-empty sentence')
    }
    return { sandbox_permissions: permission, justification: reason }
  }
  return undefined
}

/**
 * Validate the escalation argument pairing a tool schema cannot express; the
 * voider face of {@link normalizeEscalationArgs} for callers that only judge
 * the pair and do not consume the normalized values.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
 * @param justification - the raw `justification` argument, if given.
 */
export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
  normalizeEscalationArgs(sandboxPermissions, justification)
}

/**
 * The mode-aware escalation paragraph an advertising tool appends to its
 * model-facing description: the standing rule (escalation is never part of an
 * ordinary call; only an action the sandbox has just denied may retry once with
 * the fields) plus what THIS composition's mode leaves reachable. The mode
 * passed in is the composition's own sandbox mode, not the call's effective
 * one — the ladder itself is checked per call at execution, so a session
 * switched narrower still escalates against the mode in force then.
 * @param mode - the composition's sandbox mode.
 * @param subject - the family's noun for the escalating action (`command` for a
 *   shell command, `file operation` for a filesystem mutation).
 * @returns the paragraph, with its leading space, ready to concatenate.
 */
export function escalationGuidance(mode: SandboxMode, subject: string): string {
  const ladder = mode === 'read-only'
    ? 'This composition confines at `read-only`, so `workspace-write` and then `danger-full-access` are reachable — request the narrowest one that suffices.'
    : mode === 'workspace-write'
      ? 'This composition confines at `workspace-write`, whose only wider mode is `danger-full-access`.'
      : 'This composition runs at `danger-full-access`, which no mode is wider than, so a call running under it has nothing to escalate to.'
  return ' Escalation is never part of an ordinary call: do not pass `sandbox_permissions` or `justification` unless this exact '
    + `${subject} has just been denied by the sandbox, and then only to retry it once, in the same turn, verbatim. `
    + 'The two fields travel together, `justification` must be a non-empty sentence, and no mode may be requested for itself or '
    + 'for a narrower one — the ladder is checked against the mode in force when the call runs. '
    + ladder
}

/**
 * The model-facing denial marker — the one vocabulary both enforcing families
 * teach and report, so the model recognizes a policy denial identically
 * whether the kernel refused a bash file effect or the filesystem provider's
 * fence refused a mutation.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields — the nudge lives at the decision point so
 * the sanctioned retry does not depend on the model recalling the tool
 * description.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * The closed outcome vocabulary of one escalation ask — structurally identical
 * to the approval seam's `ApprovalOutcome` so an `ApprovalService.request`
 * return is assignable without this package importing it.
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The minimal approval-request shape {@link approveEscalation} needs —
 * structurally the approval seam's `ApprovalService`, generic over the agent
 * type `A` and call-id type `C` so this package resolves escalations through
 * `ctx.approval` without importing the approval or agent packages (the tool
 * layer infers `A`/`C` as its own `Agent`/`ToolCallId`).
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * Ask the human to approve one action, resolving to a closed outcome.
   * @param req - the audit-self-contained request (agent, tool, call id, reason, optional signal).
   * @returns the human's decision as a closed {@link EscalationOutcome}.
   */
  request(req: { agent: A; toolName: string; callId: C; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome>
}

/**
 * The approval ingredients an escalating tool hands {@link approveEscalation}:
 * the approval requester (`ctx.approval`, or `undefined` when none is
 * composed), the calling agent (or `undefined` for an agent-less execution),
 * and the call's identity. The tool layer holds all of these; this package
 * only judges them.
 */
export interface EscalationApproval<A = object, C = string> {
  /** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
  approver: EscalationApprover<A, C> | undefined
  /** The calling agent, or `undefined` for an agent-less execution (fails closed). */
  agent: A | undefined
  /** The tool-call id the approval prompt attaches to. */
  callId: C
  /** The tool name recorded on the approval request. */
  toolName: string
  /** The tool-execution abort signal the approval request rides, when present. */
  signal?: AbortSignal
}

/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS} when advertised). */
  requestedMode: string
  /** The model's one-sentence reason, shown verbatim to the user inside the audit reason. */
  justification: string
  /** The call's effective mode (session override ?? composition default) the request must strictly widen. */
  effectiveMode: SandboxMode
  /** The family's noun for the escalated action in user-facing texts (`command` for bash, `operation` for fs). */
  subject: string
}

/**
 * Resolve a sandbox-escalation request BEFORE anything executes: check strict
 * widening against the call's effective mode, then resolve the approval
 * channel, then map every outcome — the ordered fail-closed sequence both
 * enforcing families share. Returns the granted mode to stamp onto exactly
 * this call; throws the distinct verbatim text for every other path (a
 * non-widening request, a missing approval service, an agent-less execution,
 * a rejection, a cancellation, an unanswerable ask) — the tool registry turns
 * the throw into the call's isError result, and nothing has run. A
 * non-widening request never prompts a human.
 * @param request - the escalation to judge (see {@link EscalationRequest}).
 * @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
 * @returns the granted mode, consumed by the one call that asked.
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  // Strict widening is an EXECUTION check against the call's effective mode —
  // deliberately not a schema constraint (the enum is the closed target
  // vocabulary; the effective mode is per-call truth).
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // Self-contained for the audit trail: approval/asked stores this reason,
  // and the target mode is part of the grant's identity.
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // The schema enum already pinned `mode` to the closed target vocabulary;
    // the check above proved it is strictly wider.
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw new Error(`the user rejected escalating this ${subject} to "${mode}"`)
    case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
