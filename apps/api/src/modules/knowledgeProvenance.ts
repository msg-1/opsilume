import { Prisma } from '@prisma/client';
import type { KnowledgeProvenance } from '../generated/contracts';
import { prisma } from '../lib/prisma';
import { legacyViews } from './investigations/legacy';

/**
 * Provenance of knowledge-base results given to the investigation agent.
 *
 * A postmortem drafted by OPSILUME (analytics.ts) quotes what an AI investigation reported at the
 * time: its "AI investigation findings (unconfirmed)" section, and timeline lines that begin
 * "AI investigation completed". Before summaries were built from the assessment, that text was a
 * model's own narrative. Postmortems are documents people can edit, so a marker inside one would
 * prove nothing; provenance is therefore decided when the result is read, from where the text sits:
 *
 *   earlier_ai_output            a chunk of the AI-findings section
 *   contains_earlier_ai_output   a chunk that quotes earlier completion messages
 *   document                     anything else (runbooks, resolution steps, people's writing)
 *
 * Earlier AI output is labelled inline and in the `provenance` field, and is never evidence for a
 * cause: the agent's guardrails count it as no support (services/ai/app/guardrails.py, and the
 * API's pass in investigations/guardrails.ts). Where the incident's latest investigation has a
 * verified outcome now, it is attached as `currentAssessment`. Nothing stored is changed.
 */

// The heading the postmortem template gives the section (analytics.ts).
const FINDINGS_HEADING = 'AI investigation findings';
const COMPLETED = /AI investigation completed\b/g;
const INLINE = '[earlier AI output, unverified] ';

export type CurrentAssessment = { investigationId: string; outcome: string | null; summary: string | null };
type Hit = { documentId: string; type: string; section: string | null; content: string };

const label = (historical: boolean) =>
  `[Earlier AI output, not evidence. ${historical ? 'Written by an AI investigation before OPSILUME checked summaries against the evidence: historical and unverified.' : 'Reported by an AI investigation; its hypotheses were not confirmed.'} Do not cite it as support for a cause.]\n`;

/** The verified outcome and summary of the latest completed investigation of each incident, as they are shown now. */
async function currentAssessments(organizationId: string, incidentIds: string[]): Promise<Map<string, CurrentAssessment>> {
  const out = new Map<string, CurrentAssessment>();
  if (!incidentIds.length) return out;
  const rows = await prisma.$queryRaw<{ id: string; incidentId: string; summary: string | null; outcome: string | null; summarySource: string | null }[]>`
    SELECT DISTINCT ON ("incidentId") id, "incidentId", summary, outcome, report->>'summarySource' AS "summarySource"
    FROM "Investigation"
    WHERE "organizationId" = ${organizationId} AND "incidentId" IN (${Prisma.join(incidentIds)}) AND status = 'COMPLETED'
    ORDER BY "incidentId", "completedAt" DESC`;
  const views = await legacyViews(organizationId, rows.map((r) => r.id));
  for (const r of rows) {
    const view = views.get(r.id)?.view;
    // Only a summary built from the assessment is given as one; anything else gives the outcome alone.
    const verified = view ? view.summarySource === 'assessment' : r.summarySource === 'assessment';
    out.set(r.incidentId, { investigationId: r.id, outcome: view ? view.outcome : r.outcome, summary: verified ? (view?.summary ?? r.summary) : null });
  }
  return out;
}

export async function withProvenance<H extends Hit>(organizationId: string, hits: H[]): Promise<(H & { provenance: KnowledgeProvenance; currentAssessment?: CurrentAssessment })[]> {
  const postmortems = [...new Set(hits.filter((h) => h.type === 'postmortem').map((h) => h.documentId))];
  const docs = postmortems.length ? await prisma.knowledgeDocument.findMany({ where: { id: { in: postmortems }, organizationId }, select: { id: true, incidentId: true } }) : [];
  const incidentOf = new Map(docs.map((d) => [d.id, d.incidentId]));
  const assessments = await currentAssessments(organizationId, [...new Set(docs.map((d) => d.incidentId).filter((i): i is string => !!i))]);
  return hits.map((h) => {
    if (h.type !== 'postmortem') return { ...h, provenance: 'document' as const };
    const incidentId = incidentOf.get(h.documentId);
    const current = incidentId ? assessments.get(incidentId) : undefined;
    const attach = current ? { currentAssessment: current } : {};
    if ((h.section ?? '').includes(FINDINGS_HEADING)) {
      const historical = !(current?.summary && h.content.includes(current.summary.slice(0, 80)));
      return { ...h, ...attach, provenance: 'earlier_ai_output' as const, content: label(historical) + h.content };
    }
    if (COMPLETED.test(h.content)) {
      COMPLETED.lastIndex = 0;
      return { ...h, ...attach, provenance: 'contains_earlier_ai_output' as const, content: h.content.replace(COMPLETED, (m) => INLINE + m) };
    }
    return { ...h, provenance: 'document' as const };
  });
}
