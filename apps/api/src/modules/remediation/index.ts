/**
 * Remediation lifecycle:
 *   PROPOSED → PENDING_APPROVAL → APPROVED → EXECUTING → EXECUTED | FAILED
 *                              ↘ REJECTED            (CANCELLED from any pre-execution state)
 * Nothing here can be triggered by the AI agent: it may only create PROPOSED actions.
 * Approval and execution are restricted to signed-in humans (requireUser).
 *
 * Effect. Every action is read_only or state_changing, decided from its type and its text
 * (lib/actionEffect.ts), never from what the proposer says.
 *   read_only       a diagnostic. Needs no approval; a human records that it was done. It is
 *                   never sent to the webhook, so a misjudged text cannot change anything.
 *   state_changing  needs at least one approval, whatever the organisation's settings say.
 *
 * Binding. An approval is given for an exact fingerprint (content.ts): everything an approver is
 * shown, everything the webhook receives, where it is carried out, and whether its source was
 * unverified. Any change supersedes the approvals and returns the action to PROPOSED. Execution
 * recomputes the fingerprint and counts only approvals given for it.
 *
 * Current rules. On submission, approval and execution the risk is re-derived (raised, never
 * lowered), approvals count only within REMEDIATION_APPROVAL_VALIDITY_HOURS and once per approver,
 * and the investigation behind an AI proposal is checked again; one that no longer supports a
 * production change requires a fresh, acknowledged human review (source.ts, safeguards.ts).
 *
 * Outcome. A webhook that times out or fails mid-flight, or a process that stops while executing
 * (system.ts sweep), leaves the outcome UNKNOWN, and the record says so. A person reconciles it
 * (applied, not applied, still unknown); it can be retried only once they record it was not
 * applied. The idempotency key stays the same across attempts so a receiver can refuse a repeat.
 *
 * By responsibility:
 *   routes.ts      HTTP routes
 *   proposals.ts   creating a proposed action; request validation
 *   content.ts     action hashing
 *   effect.ts      effect classification, risk floor, approvals required
 *   approvals.ts   approval management and binding
 *   source.ts      whether the investigation behind an AI proposal still supports it
 *   safeguards.ts  raising the risk, and sending an action back for a fresh review
 *   execution.ts   webhook dispatch and manual attestation
 *   recording.ts   recording the outcome and its effect on the service history
 *   presenter.ts   loading an action and shaping the response
 */
export { REMEDIATION_TYPES } from '../../generated/contracts';
export { contentHash } from './content';
export { effectiveRisk } from './effect';
export { proposeRemediation, remediationInput } from './proposals';
export { remediationRouter } from './routes';
