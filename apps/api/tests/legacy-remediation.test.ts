import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { contentHash } from '../src/modules/remediation';
import { createOrg, createService, prisma } from './helpers';

// Remediation actions stored by earlier versions, held to the current rules when they are
// submitted, approved or executed (modules/remediation/source.ts, safeguards.ts, approvals.ts).
// Each older action is inserted as the code of its time stored it; nothing calls a model.

type Org = Awaited<ReturnType<typeof createOrg>>;
type Assessment = { outcome: string; confidence: number; rationale: string; supportingRefs: string[]; signals: unknown[]; missingTelemetry: string[] };

const incident = (refs: string[] = ['E1']): Assessment => ({ outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: refs, signals: [], missingTelemetry: [] });
const HOUR = 3_600_000;
const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, meta: a.metadata as Record<string, unknown> | null }));

/** A completed investigation as an older version stored it: no summarySource, the model's text as the summary. */
async function sourceInvestigation(org: Org, assessment: unknown, recorded = ['E1', 'E2'], hypotheses: { title: string; confidence: number; status: string; evidenceRefs: string[] }[] = [], engine = 'llm') {
  return prisma.investigation.create({
    data: {
      organizationId: org.organizationId,
      question: 'Why is checkout failing?',
      status: 'COMPLETED',
      provider: 'anthropic',
      model: 'model-of-the-time',
      analysisMode: engine,
      summary: 'Checkout is broken by v2, certainly.',
      confidence: 0.8,
      outcome: (assessment as Assessment | undefined)?.outcome ?? 'INCIDENT',
      completedAt: new Date(),
      report: { summary: 'Checkout is broken by v2, certainly.', confidence: 0.8, analysisMode: engine, ...(assessment === undefined ? {} : { assessment }), hypotheses: hypotheses.map((h) => ({ ...h, description: 'd' })) } as never,
      evidence: { create: recorded.map((ref) => ({ ref, kind: 'log_pattern', title: `${ref} title`, summary: `${ref} summary` })) },
      hypotheses: { create: hypotheses.map((h, i) => ({ ...h, rank: i + 1, description: 'd', contradictingRefs: [], contradictions: [], facts: [], assumptions: [], gaps: [] })) },
    },
  });
}

type ActionOptions = { investigationId?: string | null; status?: 'PROPOSED' | 'PENDING_APPROVAL' | 'APPROVED'; type?: string; risk?: 'LOW' | 'MEDIUM' | 'HIGH'; rationale?: string; approvers?: { userId: string; at?: Date }[]; requestedById?: string; required?: number };

/** An AI-proposed production change as an older version stored it, possibly submitted and approved already. */
async function olderAction(org: Org, o: ActionOptions) {
  const service = await createService(org.owner, `Checkout ${Math.random().toString(36).slice(2, 7)}`);
  const created = await prisma.remediationAction.create({
    data: {
      organizationId: org.organizationId,
      investigationId: o.investigationId ?? null,
      type: o.type ?? 'rollback_deployment',
      title: 'Roll back checkout to v1',
      description: 'Redeploy checkout v1, the version before the errors began.',
      rationale: o.rationale ?? 'Errors began after v2 was deployed.\nEvidence: E1, E2',
      risk: o.risk ?? 'MEDIUM',
      serviceId: service.id,
      proposedByType: 'ai_agent',
      effect: 'state_changing',
      status: o.status ?? 'PROPOSED',
      requiredApprovals: o.required ?? 1,
      ...(o.status && o.status !== 'PROPOSED' ? { requestedById: o.requestedById ?? org.ownerId, requestedAt: new Date() } : {}),
    },
  });
  const hash = contentHash(created);
  if (o.status && o.status !== 'PROPOSED') await prisma.remediationAction.update({ where: { id: created.id }, data: { contentHash: hash } });
  for (const a of o.approvers ?? []) await prisma.approval.create({ data: { actionId: created.id, approverId: a.userId, decision: 'approved', contentHash: hash, createdAt: a.at ?? new Date() } });
  return created;
}

const path = (id: string) => `/api/v1/remediations/${id}`;

describe('older AI proposals and the investigation behind them', () => {
  it('a proposal whose investigation still supports it goes through as before, with no extra step', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id });
    const shown = (await org.owner.get(path(action.id)).expect(200)).body;
    expect(shown.sourceReview).toEqual({ required: true, verified: true, reasons: [] });
    expect(shown.currentHash).toBe(contentHash(action));
    await org.owner.post(`${path(action.id)}/request-approval`).send({}).expect(200);
    await approver.agent.post(`${path(action.id)}/approve`).send({ expectedHash: shown.currentHash }).expect(200);
    const done = (await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true }).expect(200)).body;
    expect(done.status).toBe('EXECUTED');
  });

  it.each([
    ['carries no assessment', undefined, ['E1', 'E2'], undefined, 'its assessment of the evidence is missing, malformed or does not match the evidence recorded'],
    ['carries a malformed assessment', { outcome: 'FINE' }, ['E1', 'E2'], undefined, 'its assessment of the evidence is missing, malformed or does not match the evidence recorded'],
    ['has an assessment citing evidence it never recorded', incident(['E1', 'E9']), ['E1', 'E2'], undefined, 'its assessment of the evidence is missing, malformed or does not match the evidence recorded'],
    ['is DEGRADED, not an incident', { ...incident(), outcome: 'DEGRADED' }, ['E1', 'E2'], undefined, 'its verified outcome is DEGRADED, not an incident'],
    ['is cited for evidence it never recorded', incident(), ['E1'], 'Errors began after v2.\nEvidence: E1, E7', 'it cites evidence the investigation did not record (E7)'],
  ])('an approved proposal whose investigation %s is not executed: it needs a fresh review', async (_label, assessment, recorded, rationale, reason) => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, assessment, recorded);
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', rationale, approvers: [{ userId: approver.userId }] });

    const shown = (await org.owner.get(path(action.id)).expect(200)).body;
    expect(shown.sourceReview).toEqual({ required: true, verified: false, reasons: [reason] });
    expect(shown.approvalsGranted).toBe(0);

    const run = await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain(reason);
    expect(run.body.error.message).toContain('Nothing was executed.');
    const after = await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id }, include: { approvals: true } });
    expect(after).toMatchObject({ status: 'PROPOSED', contentHash: null, executedAt: null, attempts: 0 });
    // The earlier approval stays on record, superseded.
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]!.supersededAt).not.toBeNull();
    expect((await auditOf(action.id)).map((a) => a.action)).toEqual(['remediation.source_review_required']);
  });

  it('after a fresh, acknowledged review by each person, the proposal can go ahead, and the audit says so', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, undefined);
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', approvers: [{ userId: approver.userId }] });
    await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true }).expect(409);

    // Submitting needs the acknowledgement.
    expect((await org.owner.post(`${path(action.id)}/request-approval`).send({})).status).toBe(409);
    await org.owner.post(`${path(action.id)}/request-approval`).send({ acknowledgeUnverifiedSource: true }).expect(200);
    const pending = (await org.owner.get(path(action.id))).body;
    expect(pending.currentHash).not.toBe(contentHash(action));
    // So does each approval; the earlier approver may decide again.
    expect((await approver.agent.post(`${path(action.id)}/approve`).send({ expectedHash: pending.currentHash })).status).toBe(409);
    await approver.agent.post(`${path(action.id)}/approve`).send({ expectedHash: pending.currentHash, acknowledgeUnverifiedSource: true }).expect(200);
    const done = (await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true }).expect(200)).body;
    expect(done.status).toBe('EXECUTED');

    const trail = await auditOf(action.id);
    expect(trail.map((a) => a.action)).toEqual(['remediation.source_review_required', 'remediation.request_approval', 'remediation.approve', 'remediation.execute_start', 'remediation.execute_success']);
    expect(trail[1]!.meta).toMatchObject({ sourceVerified: false, acknowledgedUnverifiedSource: true });
    expect(trail[2]!.meta).toMatchObject({ sourceVerified: false, acknowledgedUnverifiedSource: true });
    expect(trail[3]!.meta).toMatchObject({ sourceVerified: false, approvedOnAcknowledgedReview: true });
  });

  it('a pending proposal whose investigation no longer supports it goes back for review when someone tries to approve it', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, { ...incident(), outcome: 'HEALTHY' });
    const action = await olderAction(org, { investigationId: inv.id, status: 'PENDING_APPROVAL' });
    const res = await approver.agent.post(`${path(action.id)}/approve`).send({ acknowledgeUnverifiedSource: true });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('its verified outcome is HEALTHY, not an incident');
    expect((await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('PROPOSED');
  });

  it('a proposal whose investigation was deleted needs a fresh review', async () => {
    const org = await createOrg();
    const action = await olderAction(org, { investigationId: null });
    expect((await org.owner.get(path(action.id))).body.sourceReview).toEqual({ required: true, verified: false, reasons: ['the investigation that proposed it no longer exists'] });
  });

  it('only the last line of the rationale is read as the evidence the proposal cites', async () => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, incident(), ['E1']);
    const action = await olderAction(org, { investigationId: inv.id, rationale: 'Evidence: E7 was considered and ruled out.\nEvidence: E1' });
    expect((await org.owner.get(path(action.id))).body.sourceReview).toEqual({ required: true, verified: true, reasons: [] });
  });

  it('an executed action keeps showing the approvals it was executed on, however long ago', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', approvers: [{ userId: approver.userId }] });
    await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true }).expect(200);
    await prisma.approval.updateMany({ where: { actionId: action.id }, data: { createdAt: new Date(Date.now() - 500 * HOUR) } });
    await prisma.evidence.deleteMany({ where: { investigationId: inv.id } });
    const shown = (await org.owner.get(path(action.id))).body;
    expect(shown).toMatchObject({ status: 'EXECUTED', approvalsGranted: 1 });
    expect(shown.approvals[0]).toMatchObject({ counts: true, expired: false });
  });

  it('a proposal made by a person needs no source', async () => {
    const org = await createOrg();
    const action = await olderAction(org, {});
    await prisma.remediationAction.update({ where: { id: action.id }, data: { proposedByType: 'user', proposedById: org.ownerId } });
    expect((await org.owner.get(path(action.id))).body.sourceReview).toEqual({ required: false, verified: true, reasons: [] });
  });

  it('showing an action changes nothing that is stored', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const action = await olderAction(org, { status: 'APPROVED', risk: 'LOW', type: 'restart_service', approvers: [{ userId: approver.userId, at: new Date(Date.now() - 200 * HOUR) }] });
    const before = await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id }, include: { approvals: true } });
    await org.owner.get(path(action.id)).expect(200);
    await org.owner.get('/api/v1/remediations').expect(200);
    expect(await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id }, include: { approvals: true } })).toEqual(before);
  });
});

describe('risk, approvals and execution under the current rules', () => {
  it('an older action stored below the current risk floor has its risk raised before execution, and its approvals stop counting', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    // A restart that changes state is at least MEDIUM now; an older version stored it as LOW.
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id, type: 'restart_service', risk: 'LOW', status: 'APPROVED', approvers: [{ userId: approver.userId }] });
    const run = await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('medium risk, not low');
    const after = await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id }, include: { approvals: true } });
    expect(after).toMatchObject({ risk: 'MEDIUM', status: 'PROPOSED', executedAt: null });
    expect(after.approvals[0]!.supersededAt).not.toBeNull();
    expect((await auditOf(action.id))[0]).toMatchObject({ action: 'remediation.risk_raised', meta: { previousRisk: 'LOW', newRisk: 'MEDIUM', previousStatus: 'APPROVED', supersededApprovals: 1 } });
  });

  it('a risk above the floor is never lowered', async () => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id, risk: 'HIGH' });
    await org.owner.post(`${path(action.id)}/request-approval`).send({}).expect(200);
    expect(await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ risk: 'HIGH', status: 'PENDING_APPROVAL' });
  });

  it(`an approval older than the validity window (${env.REMEDIATION_APPROVAL_VALIDITY_HOURS} h) no longer counts; its approver may approve again`, async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    const old = new Date(Date.now() - (env.REMEDIATION_APPROVAL_VALIDITY_HOURS + 1) * HOUR);
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', approvers: [{ userId: approver.userId, at: old }] });
    const shown = (await org.owner.get(path(action.id))).body;
    expect(shown.approvals[0]).toMatchObject({ counts: false, expired: true });
    expect(shown.approvalsGranted).toBe(0);

    const run = await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain(`older than ${env.REMEDIATION_APPROVAL_VALIDITY_HOURS} hours`);
    expect(await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: 'PENDING_APPROVAL', executedAt: null });
    expect((await auditOf(action.id)).map((a) => a.action)).toEqual(['remediation.approval_expired']);

    await approver.agent.post(`${path(action.id)}/approve`).send({ expectedHash: shown.currentHash }).expect(200);
    expect((await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true }).expect(200)).body.status).toBe('EXECUTED');
    const approvals = await prisma.approval.findMany({ where: { actionId: action.id }, orderBy: { createdAt: 'asc' } });
    expect(approvals).toHaveLength(2);
    expect(approvals[0]!.supersededAt).not.toBeNull();
  });

  it('an expired approval does not stop its approver deciding again on a pending action', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id, status: 'PENDING_APPROVAL', required: 2, approvers: [{ userId: approver.userId, at: new Date(Date.now() - 100 * HOUR) }] });
    const hash = (await org.owner.get(path(action.id))).body.currentHash;
    await approver.agent.post(`${path(action.id)}/approve`).send({ expectedHash: hash }).expect(200);
    expect((await auditOf(action.id)).map((a) => a.action)).toEqual(['remediation.approval_expired', 'remediation.approve']);
  });

  it('one person approving twice counts once', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    // Two rows from one approver, as two concurrent requests could have left them.
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', required: 2, approvers: [{ userId: approver.userId }, { userId: approver.userId }] });
    expect((await org.owner.get(path(action.id))).body.approvalsGranted).toBe(1);
    const run = await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain('needs 2 approvals and has 1');
  });

  it('an action is executed once, however often it is asked for', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    const inv = await sourceInvestigation(org, incident());
    const action = await olderAction(org, { investigationId: inv.id, status: 'APPROVED', approvers: [{ userId: approver.userId }] });
    const runs = await Promise.all([1, 2, 3].map(() => org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true })));
    expect(runs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await org.owner.post(`${path(action.id)}/execute`).send({ confirmManual: true })).status).toBe(409);
    expect(await prisma.remediationAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: 'EXECUTED', attempts: 1 });
    expect((await auditOf(action.id)).filter((a) => a.action === 'remediation.execute_start')).toHaveLength(1);
  });
});

describe('hypothesis confidence of older reports', () => {
  const likely = { title: 'v2 broke checkout', confidence: 0.8, status: 'likely', evidenceRefs: ['E1'] };

  it.each([
    ['HEALTHY', { ...incident(), outcome: 'HEALTHY' }, likely, { confidence: 0.2, status: 'unlikely' }],
    ['UNDETERMINED', { ...incident([]), outcome: 'UNDETERMINED' }, likely, { confidence: 0.2, status: 'unlikely' }],
    ['DEGRADED', { ...incident(), outcome: 'DEGRADED' }, likely, { confidence: 0.45, status: 'possible' }],
    ['no assessment', undefined, likely, { confidence: 0.45, status: 'possible' }],
    ['an assessment citing unrecorded evidence', incident(['E9']), likely, { confidence: 0.45, status: 'possible' }],
    ['INCIDENT, hypothesis citing only unrecorded evidence', incident(), { ...likely, evidenceRefs: ['E9'] }, { confidence: 0.3, status: 'possible' }],
  ])('%s: shown at the rating the current rules permit, with the stored one beside it', async (_label, assessment, hypothesis, expected) => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, assessment, ['E1', 'E2'], [hypothesis]);
    const detail = (await org.owner.get(`/api/v1/investigations/${inv.id}`).expect(200)).body;
    expect(detail.hypotheses[0]).toMatchObject({ ...expected, asRecorded: { confidence: 0.8, status: 'likely' } });
    expect(detail.report.hypotheses[0]).toMatchObject(expected);
    expect(detail.confidence).toBe(expected.confidence);
    expect(detail.confidenceAsRecorded).toBe(0.8);
    const listed = (await org.owner.get('/api/v1/investigations')).body.data.find((i: { id: string }) => i.id === inv.id);
    expect(listed.confidence).toBe(expected.confidence);
    // Stored values are untouched.
    expect(await prisma.hypothesis.findFirstOrThrow({ where: { investigationId: inv.id } })).toMatchObject({ confidence: 0.8, status: 'likely' });
    expect((await prisma.investigation.findUniqueOrThrow({ where: { id: inv.id } })).confidence).toBe(0.8);
  });

  it('INCIDENT with a supported hypothesis: shown as stored', async () => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, incident(), ['E1', 'E2'], [likely]);
    const detail = (await org.owner.get(`/api/v1/investigations/${inv.id}`)).body;
    expect(detail.hypotheses[0]).toMatchObject({ confidence: 0.8, status: 'likely' });
    expect(detail.hypotheses[0].asRecorded).toBeUndefined();
    expect(detail.confidenceAsRecorded).toBeUndefined();
  });

  it.each([
    ['rule-based', 'heuristic', { confidence: 0.45, status: 'possible' }],
    ['mock', 'mock', { confidence: 0.1, status: 'possible' }],
  ])('an older %s report is capped too; a rule-based summary stays its own', async (_label, engine, expected) => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, { ...incident(), outcome: 'DEGRADED' }, ['E1', 'E2'], [likely], engine);
    const detail = (await org.owner.get(`/api/v1/investigations/${inv.id}`)).body;
    expect(detail.hypotheses[0]).toMatchObject({ ...expected, asRecorded: { confidence: 0.8, status: 'likely' } });
    if (engine === 'heuristic') expect(detail.summary).toBe('Checkout is broken by v2, certainly.');
    const dashboard = (await org.owner.get('/api/v1/dashboard')).body;
    expect(dashboard.recentInvestigations.find((i: { id: string }) => i.id === inv.id).confidence).toBe(expected.confidence);
  });

  it('an older rule-based report keeps its completion message, without a confidence figure the current rules would not show', async () => {
    const org = await createOrg();
    const created = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout is failing' })).body;
    const inv = await sourceInvestigation(org, { ...incident(), outcome: 'DEGRADED' }, ['E1', 'E2'], [likely], 'heuristic');
    await prisma.investigation.update({ where: { id: inv.id }, data: { incidentId: created.id } });
    await prisma.incidentEvent.create({ data: { incidentId: created.id, type: 'investigation', message: 'AI investigation completed (80% confidence): Errors began after v2.', actorType: 'ai_agent', actorLabel: 'OPSILUME AI', metadata: { investigationId: inv.id } } });
    const timeline = (await org.owner.get(`/api/v1/incidents/${created.id}`)).body.timeline as { type: string; message: string }[];
    expect(timeline.find((e) => e.type === 'investigation')!.message).toBe('AI investigation completed: Errors began after v2.');
  });

  it('a report stored under the current rules is shown exactly as stored', async () => {
    const org = await createOrg();
    const inv = await sourceInvestigation(org, { ...incident(), outcome: 'DEGRADED' }, ['E1', 'E2'], [likely]);
    await prisma.investigation.update({ where: { id: inv.id }, data: { report: { ...(inv.report as object), summarySource: 'assessment' } as never } });
    const detail = (await org.owner.get(`/api/v1/investigations/${inv.id}`)).body;
    expect(detail.hypotheses[0]).toMatchObject({ confidence: 0.8, status: 'likely' });
  });

  it('a postmortem drafted now prints the permitted rating and the recorded one', async () => {
    const org = await createOrg();
    const created = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout is failing' })).body;
    const inv = await sourceInvestigation(org, { ...incident(), outcome: 'DEGRADED' }, ['E1', 'E2'], [likely]);
    await prisma.investigation.update({ where: { id: inv.id }, data: { incidentId: created.id } });
    const doc = (await org.owner.post(`/api/v1/incidents/${created.id}/postmortem`)).body;
    const content = (await org.owner.get(`/api/v1/knowledge/documents/${doc.id}`)).body.content as string;
    expect(content).toContain('overall confidence 45% (recorded at the time as 80%, above what the current rules allow)');
    expect(content).toContain('(45%, possible; recorded at the time as 80%, likely)');
  });
});
