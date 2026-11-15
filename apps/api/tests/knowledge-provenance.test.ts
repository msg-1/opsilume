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

/** A postmortem as OPSILUME drafted them before summaries were built from the assessment: the model's text in the findings and the timeline. */
const historicalPostmortem = (title: string) => `# Postmortem: ${title}

## Summary
- **Severity:** SEV2

## Root cause
_Not yet confirmed by the incident team._

## Resolution
Raised DB_POOL_MAX back to 40 and rolled the deployment.

## AI investigation findings (unconfirmed)
Analysis by anthropic / model, overall confidence 95%. These are hypotheses, not confirmed causes.

${MODEL_TEXT}

1. **Connection pool exhausted** (95%, likely) — the pool was exhausted.

## Timeline
- 2026-06-01 10:00 UTC — Incident opened as SEV2
- 2026-06-01 10:20 UTC — AI investigation completed (95% confidence): ${MODEL_TEXT} _(OPSILUME AI)_
`;

async function search(org: Org, query: string) {
  const key = await createApiKey(org.owner, ['tools:read']);
  return (await api().post('/api/v1/tools/knowledge/search').set('x-api-key', key).send({ query, limit: 10 }).expect(200)).body.results as {
    documentId: string; type: string; section: string | null; content: string; provenance: string; currentAssessment?: { outcome: string | null; summary: string | null };
  }[];
}

/** An incident with an older model investigation (a trusted INCIDENT assessment) and a postmortem drafted from it then. */
async function incidentWithHistoricalPostmortem(org: Org) {
  const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout pool outage' })).body;
  await prisma.investigation.create({
    data: {
      organizationId: org.organizationId, incidentId: incident.id, question: 'Why did checkout fail?', status: 'COMPLETED', provider: 'anthropic', model: 'm', analysisMode: 'llm',
      summary: MODEL_TEXT, confidence: 0.95, outcome: 'INCIDENT', completedAt: new Date(),
      report: { summary: MODEL_TEXT, confidence: 0.95, analysisMode: 'llm', assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'] }, hypotheses: [] } as never,
      evidence: { create: [{ ref: 'E1', kind: 'log_pattern', title: 'E1', summary: 'E1' }] },
    },
  });
  const doc = (await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Postmortem: Checkout pool outage', type: 'postmortem', content: historicalPostmortem('Checkout pool outage') }).expect(201)).body;
  await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { incidentId: incident.id } });
  return { incident, doc };
}

describe('earlier AI output in the knowledge base', () => {
  it('is labelled as historical and unverified, with the verified assessment beside it; useful steps stay plain', async () => {
    const org = await createOrg();
    const { doc } = await incidentWithHistoricalPostmortem(org);
    const stored = (await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } })).content;
    const results = (await search(org, 'connection pool exhausted checkout DB_POOL_MAX')).filter((r) => r.documentId === doc.id);

    const findings = results.find((r) => r.section?.includes('AI investigation findings'))!;
    expect(findings.provenance).toBe('earlier_ai_output');
    expect(findings.content.startsWith('[Earlier AI output, not evidence. Written by an AI investigation before OPSILUME checked summaries against the evidence: historical and unverified.')).toBe(true);
    expect(findings.content).toContain(MODEL_TEXT); // kept, not rewritten
    expect(findings.currentAssessment).toMatchObject({ outcome: 'INCIDENT', summary: 'Assessed outcome: INCIDENT. A failure is evident (E1).' });

    const timeline = results.find((r) => r.section?.includes('Timeline'))!;
    expect(timeline.provenance).toBe('contains_earlier_ai_output');
    expect(timeline.content).toContain('[earlier AI output, unverified] AI investigation completed (95% confidence)');

    const resolution = results.find((r) => r.section?.includes('Resolution'))!;
    expect(resolution).toMatchObject({ provenance: 'document', content: 'Raised DB_POOL_MAX back to 40 and rolled the deployment.' });
    // The document itself is unchanged.
    expect((await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } })).content).toBe(stored);
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
      {
        type: 'final',
        report: {
          summary: 's', confidence: 0.8, analysisMode: 'llm',
          assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'], signals: [], missingTelemetry: [] },
          timeline: [], assumptions: [], uncertainties: ['u'], nextSteps: ['n'], recommendedActions: [],
          facts: [{ statement: 'The pool was exhausted last time.', evidenceRefs: ['E2'] }, { statement: 'Errors are rising.', evidenceRefs: ['E1'] }],
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
    expect(inv.report.assumptions).toContain('The pool was exhausted last time.');
    expect(inv.steps.find((s: { type: string }) => s.type === 'guardrail').detail).toContain('cites only earlier AI output, which is not evidence');
  });
});
