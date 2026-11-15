import { describe, expect, it, vi } from 'vitest';
import type { InvestigationEvent } from '../src/integrations/aiService';

// What the investigation agent is given when it searches the knowledge base, and what the API's
// guardrails do with it (modules/knowledgeProvenance.ts). Indexing runs for real; embeddings come
// from a deterministic double, and nothing calls a model.
const ai = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../src/integrations/aiService', () => ({
  aiService: {
    status: async () => ({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } }),
    embed: async (texts: string[]) => ({ provider: 'test', model: 'unit', dimensions: 768, vectors: texts.map(() => [1, ...new Array(767).fill(0)]) }),
    runInvestigation: async (_request: never, onEvent: (e: InvestigationEvent) => Promise<void>) => {
      for (const event of ai.events) await onEvent(event as InvestigationEvent);
    },
  },
}));

import { createApiKey, createOrg, createService, minutesAgo, prisma } from './helpers';
import { api } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;

const MODEL_TEXT = 'Checkout broke because the connection pool was exhausted, certainly.';
const VERIFIED = 'Assessed outcome: INCIDENT. A failure is evident (E1).';

const RESOLUTION = 'Raised DB_POOL_MAX back to 40 and rolled the deployment.';
const HYPOTHESIS = 'The pool size was lowered in v2 and requests waited for connections.';

/** A postmortem as OPSILUME drafted them before summaries were built from the assessment: the model's text in the findings and the timeline. */
const historicalPostmortem = (findingsHeading = '## AI investigation findings (unconfirmed)', order: 'template' | 'reordered' = 'template', modelText = MODEL_TEXT) => {
  const resolution = `## Resolution\n${RESOLUTION}`;
  const findings = `${findingsHeading}\nAnalysis by anthropic / model, overall confidence 95%. These are hypotheses, not confirmed causes.\n\n${modelText}\n\n1. **Connection pool exhausted** (95%, likely) — ${HYPOTHESIS}`;
  const timeline = `## Timeline\n- 2026-06-01 10:00 UTC — Incident opened as SEV2\n- 2026-06-01 10:20 UTC — AI investigation completed (95% confidence): ${modelText.slice(0, 280)} _(OPSILUME AI)_`;
  const body = order === 'template' ? [resolution, findings, timeline] : [timeline, findings, resolution];
  return ['# Postmortem: Checkout pool outage', '## Summary\n- **Severity:** SEV2', '## Root cause\n_Not yet confirmed by the incident team._', ...body].join('\n\n');
};

async function search(org: Org, query: string) {
  const key = await createApiKey(org.owner, ['tools:read']);
  return (await api().post('/api/v1/tools/knowledge/search').set('x-api-key', key).send({ query, limit: 10 }).expect(200)).body.results as {
    documentId: string; type: string; section: string | null; content: string; provenance: string; provenanceBasis: string; currentAssessment?: { outcome: string | null; summary: string | null };
  }[];
}

/**
 * An incident with an older model investigation (a trusted INCIDENT assessment) and a postmortem
 * OPSILUME drafted from it at the time: linked to the incident, with the audit entry the
 * generator wrote. `content` is the postmortem as it reads now, possibly edited since.
 */
async function draftedEarlier(org: Org, content: string, modelText = MODEL_TEXT, { audited = true } = {}) {
  const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout pool outage' })).body;
  await prisma.incident.update({ where: { id: incident.id }, data: { resolution: RESOLUTION } });
  const inv = await prisma.investigation.create({
    data: {
      organizationId: org.organizationId, incidentId: incident.id, question: 'Why did checkout fail?', status: 'COMPLETED', provider: 'anthropic', model: 'm', analysisMode: 'llm',
      summary: modelText, confidence: 0.95, outcome: 'INCIDENT', completedAt: new Date(),
      report: { summary: modelText, confidence: 0.95, analysisMode: 'llm', assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'] }, hypotheses: [] } as never,
      evidence: { create: [{ ref: 'E1', kind: 'log_pattern', title: 'E1', summary: 'E1' }] },
      hypotheses: { create: [{ rank: 1, title: 'Connection pool exhausted', description: HYPOTHESIS, confidence: 0.95, status: 'likely', evidenceRefs: ['E1'], contradictingRefs: [], contradictions: [], facts: [], assumptions: [], gaps: [] }] },
    },
  });
  await prisma.incidentEvent.create({ data: { incidentId: incident.id, type: 'investigation', message: `AI investigation completed (95% confidence): ${modelText.slice(0, 280)}`, actorType: 'ai_agent', actorLabel: 'OPSILUME AI', metadata: { investigationId: inv.id } } });
  const doc = (await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Postmortem: Checkout pool outage', type: 'postmortem', content }).expect(201)).body;
  await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { incidentId: incident.id } });
  if (audited) await prisma.auditLog.create({ data: { organizationId: org.organizationId, actorType: 'user', actorLabel: 'Olivia Owner', action: 'postmortem.create', resourceType: 'knowledge_document', resourceId: doc.id } });
  return { incident, doc, inv };
}

const of = async (org: Org, docId: string, query = 'connection pool exhausted checkout DB_POOL_MAX lowered requests waited') => (await search(org, query)).filter((r) => r.documentId === docId);
const holding = (results: Awaited<ReturnType<typeof of>>, text: string) => results.filter((r) => r.content.includes(text));

describe('earlier AI output in the knowledge base', () => {
  it.each([
    ['its original headings', historicalPostmortem()],
    ['the findings heading renamed', historicalPostmortem('## What the tool thought')],
    ['no findings heading at all', historicalPostmortem('')],
    ['its sections reordered', historicalPostmortem('## Notes', 'reordered')],
  ])('a postmortem drafted before verified summaries, with %s: the model text is earlier AI output, the resolution stays a plain document', async (_label, content) => {
    const org = await createOrg();
    const { doc } = await draftedEarlier(org, content);
    const stored = (await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } })).content;
    const results = await of(org, doc.id);

    // Wherever the findings ended up (their own section, another one, merged with the resolution),
    // they are matched to the investigation that wrote them, never to a heading.
    const findings = holding(results, 'Analysis by anthropic');
    expect(findings.length).toBeGreaterThan(0);
    for (const r of findings) {
      expect(['earlier_ai_output', 'contains_earlier_ai_output']).toContain(r.provenance);
      expect(r.provenanceBasis).toBe('source_match');
      expect(r.currentAssessment).toMatchObject({ outcome: 'INCIDENT', summary: 'Assessed outcome: INCIDENT. A failure is evident (E1).' });
      if (r.provenance === 'earlier_ai_output') expect(r.content.startsWith('[Earlier AI output, not evidence. Written by an AI investigation before OPSILUME checked summaries against the evidence: historical and unverified.')).toBe(true);
      else expect(r.content).toContain(`[earlier AI output, unverified] ${MODEL_TEXT}`);
    }
    // Everything that quotes the model, the hypotheses or the completion message is not a plain document.
    for (const r of [...holding(results, MODEL_TEXT), ...holding(results, HYPOTHESIS)]) expect(r.provenance).not.toBe('document');

    // The resolution people recorded stays usable as written: a plain document, or unlabelled inside a mixed chunk.
    const resolution = holding(results, RESOLUTION);
    expect(resolution.length).toBeGreaterThan(0);
    for (const r of resolution) {
      if (r.provenance === 'document') expect(r).toMatchObject({ provenanceBasis: 'incident_record', content: RESOLUTION });
      else expect(r.content).not.toContain(`[earlier AI output, unverified] ${RESOLUTION}`);
    }
    // The document itself is unchanged.
    expect((await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } })).content).toBe(stored);
  });

  it('model text split across chunk boundaries is recognised in every chunk it reaches', async () => {
    const org = await createOrg();
    const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i + 1} of the model's account says the connection pool in checkout was exhausted under load.`).join(' ');
    const { doc } = await draftedEarlier(org, historicalPostmortem('## Findings', 'template', long), long);
    const chunks = await prisma.knowledgeChunk.findMany({ where: { documentId: doc.id }, orderBy: { index: 'asc' } });
    const parts = chunks.filter((c) => c.content.includes("of the model's account"));
    expect(parts.length).toBeGreaterThan(1); // the passage really is split
    const results = await of(org, doc.id, "model's account connection pool exhausted under load sentence");
    const seen = results.filter((r) => r.content.includes("of the model's account"));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.provenance).not.toBe('document');
  });

  it('a drafted postmortem whose sources are no longer stored is of unknown origin, not a plain document', async () => {
    const org = await createOrg();
    const { doc, inv } = await draftedEarlier(org, historicalPostmortem('## Notes'));
    await prisma.investigation.delete({ where: { id: inv.id } });
    await prisma.incidentEvent.deleteMany({ where: { type: 'investigation', metadata: { path: ['investigationId'], equals: inv.id } } });
    const findings = holding(await of(org, doc.id), 'Analysis by anthropic');
    expect(findings.length).toBeGreaterThan(0);
    for (const r of findings) {
      expect(r).toMatchObject({ provenance: 'unknown', provenanceBasis: 'unmatched' });
      expect(r.content.startsWith('[Origin unknown, not evidence.')).toBe(true);
    }
  });

  it('historical findings and a resolution procedure in one chunk: the AI passages are labelled where they stand, and the chunk is not evidence', async () => {
    const org = await createOrg();
    const content = `# Postmortem: Checkout pool outage\n\n## Everything we learned\n${MODEL_TEXT}\n\n${RESOLUTION}`;
    const { doc } = await draftedEarlier(org, content);
    const [mixed] = holding(await of(org, doc.id), RESOLUTION);
    expect(mixed).toMatchObject({ provenance: 'contains_earlier_ai_output', provenanceBasis: 'source_match' });
    expect(mixed!.content).toContain(`[earlier AI output, unverified] ${MODEL_TEXT}`);
    expect(mixed!.content).toContain(`\n${RESOLUTION}`);
    expect(mixed!.content).not.toContain(`[earlier AI output, unverified] ${RESOLUTION}`);
  });

  it('a postmortem OPSILUME did not draft (no generator record, as the seed writes them) is a plain document', async () => {
    const org = await createOrg();
    const { doc } = await draftedEarlier(org, historicalPostmortem(), MODEL_TEXT, { audited: false });
    for (const r of await of(org, doc.id)) expect(r).toMatchObject({ provenance: 'document', provenanceBasis: 'not_generated' });
  });

  it('a postmortem drafted now carries the verified summary, and is labelled as AI output that was checked', async () => {
    const org = await createOrg();
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Orders failing' })).body;
    await prisma.investigation.create({
      data: {
        organizationId: org.organizationId, incidentId: incident.id, question: 'Why?', status: 'COMPLETED', provider: 'anthropic', model: 'm', analysisMode: 'llm',
        summary: VERIFIED, confidence: 0.7, outcome: 'INCIDENT', completedAt: new Date(),
        report: { summary: VERIFIED, summarySource: 'assessment', narrative: MODEL_TEXT, confidence: 0.7, analysisMode: 'llm', assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'] }, hypotheses: [] } as never,
        evidence: { create: [{ ref: 'E1', kind: 'log_pattern', title: 'E1', summary: 'E1' }] },
      },
    });
    const doc = (await org.owner.post(`/api/v1/incidents/${incident.id}/postmortem`)).body;
    const content = (await org.owner.get(`/api/v1/knowledge/documents/${doc.id}`)).body.content as string;
    expect(content).toContain(VERIFIED);
    expect(content).not.toContain(MODEL_TEXT);
    const findings = (await search(org, 'Assessed outcome failure evident')).find((r) => r.documentId === doc.id && r.section?.includes('AI investigation findings'))!;
    expect(findings.provenance).toBe('earlier_ai_output');
    expect(findings.content.startsWith('[Earlier AI output, not evidence. Reported by an AI investigation; its hypotheses were not confirmed.')).toBe(true);
  });

  it('runbooks and postmortems people wrote are plain documents', async () => {
    const org = await createOrg();
    const doc = (await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Runbook: pool exhaustion', type: 'runbook', content: '# Pool exhaustion\n\nRaise DB_POOL_MAX to 40 and roll the deployment.' }).expect(201)).body;
    const results = (await search(org, 'pool exhaustion DB_POOL_MAX')).filter((r) => r.documentId === doc.id);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.provenance).toBe('document');
  });

  it('cannot become support for a cause or a fact in a report', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Checkout');
    const evidence = (ref: string, kind: string, data?: Record<string, unknown>) => ({ type: 'evidence', evidence: { ref, kind, title: `${ref} ${kind}`, summary: 's', sourceType: kind, sourceId: `${kind}-${ref}`, occurredAt: minutesAgo(30), ...(data ? { data } : {}) } });
    ai.events = [
      evidence('E1', 'log_pattern'),
      evidence('E2', 'document', { docType: 'postmortem', provenance: 'earlier_ai_output' }),
      evidence('E3', 'document', { docType: 'postmortem', provenance: 'unknown' }),
      // An older AI service that does not say: not evidence either.
      evidence('E4', 'document', { docType: 'postmortem' }),
      {
        type: 'final',
        report: {
          summary: 's', confidence: 0.8, analysisMode: 'llm',
          assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'], signals: [], missingTelemetry: [] },
          timeline: [], assumptions: [], uncertainties: ['u'], nextSteps: ['n'],
          recommendedActions: [{ type: 'config_change', title: 'Raise the pool size, as the old postmortem said', description: 'Set DB_POOL_MAX=40.', risk: 'MEDIUM', evidenceRefs: ['E2', 'E3', 'E4'] }],
          facts: [{ statement: 'The pool was exhausted last time.', evidenceRefs: ['E2'] }, { statement: 'Someone wrote it was the pool.', evidenceRefs: ['E3', 'E4'] }, { statement: 'Errors are rising.', evidenceRefs: ['E1'] }],
          hypotheses: [
            { title: 'Pool exhausted, as the old postmortem said', description: 'd', confidence: 0.8, status: 'likely', evidenceRefs: ['E2'], facts: [], assumptions: [], gaps: [] },
            { title: 'Something in the errors', description: 'd', confidence: 0.6, status: 'likely', evidenceRefs: ['E1', 'E2'], facts: [], assumptions: [], gaps: [] },
          ],
        },
      },
    ];
    const id = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?' })).body.id;
    const inv = (await org.owner.get(`/api/v1/investigations/${id}`)).body;
    const byTitle = Object.fromEntries(inv.report.hypotheses.map((h: { title: string; status: string; confidence: number }) => [h.title, h]));
    expect(byTitle['Pool exhausted, as the old postmortem said']).toMatchObject({ status: 'possible', confidence: 0.3 });
    expect(byTitle['Something in the errors']).toMatchObject({ status: 'likely', confidence: 0.6 });
    expect(inv.report.facts.map((f: { statement: string }) => f.statement)).toEqual(['Errors are rising.']);
    expect(inv.report.assumptions).toEqual(expect.arrayContaining(['The pool was exhausted last time.', 'Someone wrote it was the pool.']));
    // The production change resting only on that text is withdrawn, not offered for approval.
    expect(inv.report.recommendedActions).toEqual([]);
    expect(inv.remediations).toEqual([]);
    expect(inv.report.nextSteps.join('\n')).toContain('rests only on knowledge-base text that is earlier AI output or of unknown origin');
    expect(inv.steps.find((s: { type: string }) => s.type === 'guardrail').detail).toContain('cites only earlier AI output, which is not evidence');
  });
});
