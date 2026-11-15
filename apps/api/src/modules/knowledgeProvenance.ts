import { Prisma } from '@prisma/client';
import type { KnowledgeProvenance } from '../generated/contracts';
import { prisma } from '../lib/prisma';
import { legacyViews } from './investigations/legacy';

/**
 * Provenance of knowledge-base results given to the investigation agent.
 *
 * A postmortem drafted by OPSILUME (analytics.ts) copies text from records that are still stored:
 * what the incident's AI investigations reported (their summaries, narratives and hypotheses, and
 * the "AI investigation completed" timeline entries) and what people recorded on the incident
 * (description, impact, root cause, resolution). Before summaries were built from the
 * assessment, the investigation's summary was a model's own narrative.
 *
 * Provenance is decided from structured records, not from the document's formatting:
 *   - whether OPSILUME generated the document: the `postmortem.create` audit entry written when it
 *     was drafted, the only way a postmortem is linked to an incident through the API;
 *   - which text came from where: passages of the chunk are matched against the stored source
 *     records themselves, so renaming, removing or reordering headings, and where a chunk
 *     happens to start, do not change the answer. The heading is used as one more signal.
 *
 *   document                     written by people: any document OPSILUME did not generate, and
 *                                generated text that matches only the incident's own records
 *   earlier_ai_output            matches what an AI investigation reported, and nothing people recorded
 *   contains_earlier_ai_output   matches both; the AI passages are labelled inline
 *   unknown                      generated, but matches no stored source (edited or paraphrased
 *                                text, a template line, sources no longer stored): not evidence
 *
 * Only `document` can support anything in a report (services/ai/app/evidence.py and the API's
 * guardrails); everything else may be read and cited, never as support. Nothing stored changes.
 */

const FINDINGS_HEADING = 'AI investigation findings';
const COMPLETED = /AI investigation completed\b/;
const INLINE = '[earlier AI output, unverified] ';
// Passages are compared in windows of this many characters (after normalising whitespace and
// case), overlapping by half, so a passage split across two chunks is still found in each part
// that is at least this long. Shorter source text is compared whole, from MIN_PASSAGE characters.
const WINDOW = 48;
const MIN_PASSAGE = 20;

export type Basis = 'not_generated' | 'source_match' | 'heading' | 'incident_record' | 'unmatched';
export type CurrentAssessment = { investigationId: string; outcome: string | null; summary: string | null };
type Hit = { documentId: string; type: string; section: string | null; content: string };

const normal = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function passages(texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    const t = normal(raw ?? '');
    if (t.length < MIN_PASSAGE) continue;
    if (t.length <= WINDOW) {
      out.add(t);
      continue;
    }
    for (let i = 0; i + WINDOW <= t.length; i += WINDOW / 2) out.add(t.slice(i, i + WINDOW));
    out.add(t.slice(-WINDOW));
  }
  return [...out];
}

const matches = (text: string, list: string[]) => {
  const t = normal(text);
  return list.some((p) => t.includes(p));
};

type Sources = { model: string[]; verified: string[]; people: string[]; current: CurrentAssessment | null };

/** The stored records a generated postmortem of each incident copied from. */
async function sourcesFor(organizationId: string, incidentIds: string[]): Promise<Map<string, Sources>> {
  const out = new Map<string, Sources>();
  if (!incidentIds.length) return out;
  const [incidents, investigations, events] = await Promise.all([
    prisma.incident.findMany({ where: { id: { in: incidentIds }, organizationId }, select: { id: true, description: true, customerImpact: true, rootCause: true, resolution: true } }),
    prisma.$queryRaw<{ id: string; incidentId: string; summary: string | null; outcome: string | null; summarySource: string | null; reportSummary: string | null; narrative: string | null; completedAt: Date | null }[]>`
      SELECT id, "incidentId", summary, outcome, report->>'summarySource' AS "summarySource", report->>'summary' AS "reportSummary", report->>'narrative' AS narrative, "completedAt"
      FROM "Investigation" WHERE "organizationId" = ${organizationId} AND "incidentId" IN (${Prisma.join(incidentIds)}) AND status = 'COMPLETED'
      ORDER BY "completedAt" DESC`,
    prisma.incidentEvent.findMany({ where: { incidentId: { in: incidentIds }, incident: { organizationId } }, select: { incidentId: true, type: true, message: true } }),
  ]);
  const hypotheses = investigations.length ? await prisma.hypothesis.findMany({ where: { investigationId: { in: investigations.map((i) => i.id) } }, select: { investigationId: true, title: true, description: true } }) : [];
  const views = await legacyViews(organizationId, investigations.map((i) => i.id));
  for (const incident of incidents) {
    const runs = investigations.filter((i) => i.incidentId === incident.id);
    const model: (string | null)[] = [];
    const verified: (string | null)[] = [];
    for (const run of runs) {
      const view = views.get(run.id)?.view;
      // What a model wrote: an older report's stored summary, and any narrative.
      if (view || !run.summarySource) model.push(run.summary, run.reportSummary);
      model.push(run.narrative);
      // What OPSILUME built from the assessment, then or now.
      if (run.summarySource === 'assessment') verified.push(run.summary);
      if (view) verified.push(view.summary);
      for (const h of hypotheses.filter((x) => x.investigationId === run.id)) model.push(h.title, h.description);
    }
    const ai = events.filter((e) => e.incidentId === incident.id && e.type === 'investigation').map((e) => e.message);
    const people = [incident.description, incident.customerImpact, incident.rootCause, incident.resolution, ...events.filter((e) => e.incidentId === incident.id && e.type !== 'investigation').map((e) => e.message)];
    const latest = runs[0];
    const latestView = latest ? views.get(latest.id)?.view : undefined;
    const current = latest
      ? { investigationId: latest.id, outcome: latestView ? latestView.outcome : latest.outcome, summary: (latestView ? latestView.summarySource === 'assessment' : latest.summarySource === 'assessment') ? (latestView?.summary ?? latest.summary) : null }
      : null;
    out.set(incident.id, { model: passages([...model, ...ai]), verified: passages(verified), people: passages(people), current });
  }
  return out;
}

const label = (historical: boolean) =>
  `[Earlier AI output, not evidence. ${historical ? 'Written by an AI investigation before OPSILUME checked summaries against the evidence: historical and unverified.' : 'Reported by an AI investigation; its hypotheses were not confirmed.'} Do not cite it as support for a cause.]\n`;
const UNKNOWN_LABEL = '[Origin unknown, not evidence. From a postmortem OPSILUME drafted, but this text does not match any record it was drafted from: it may be edited or paraphrased earlier AI output.]\n';

export async function withProvenance<H extends Hit>(organizationId: string, hits: H[]): Promise<(H & { provenance: KnowledgeProvenance; provenanceBasis: Basis; currentAssessment?: CurrentAssessment })[]> {
  const postmortemIds = [...new Set(hits.filter((h) => h.type === 'postmortem').map((h) => h.documentId))];
  const [docs, drafted] = postmortemIds.length
    ? await Promise.all([
        prisma.knowledgeDocument.findMany({ where: { id: { in: postmortemIds }, organizationId }, select: { id: true, incidentId: true } }),
        prisma.auditLog.findMany({ where: { organizationId, action: 'postmortem.create', resourceType: 'knowledge_document', resourceId: { in: postmortemIds } }, select: { resourceId: true } }),
      ])
    : [[], []];
  const generated = new Set(drafted.map((a) => a.resourceId));
  const incidentOf = new Map(docs.map((d) => [d.id, d.incidentId]));
  const sources = await sourcesFor(organizationId, [...new Set(docs.filter((d) => generated.has(d.id) && d.incidentId).map((d) => d.incidentId!))]);

  return hits.map((h) => {
    if (h.type !== 'postmortem' || !generated.has(h.documentId)) return { ...h, provenance: 'document' as const, provenanceBasis: 'not_generated' as const };
    const incidentId = incidentOf.get(h.documentId);
    const src = incidentId ? sources.get(incidentId) : undefined;
    const attach = src?.current ? { currentAssessment: src.current } : {};
    const ai = src ? [...src.model, ...src.verified] : [];
    const people = src?.people ?? [];
    const aiHit = matches(h.content, ai);
    const headingHit = (h.section ?? '').includes(FINDINGS_HEADING) || COMPLETED.test(h.content);
    const peopleHit = matches(h.content, people);
    if (aiHit || headingHit) {
      const historical = !src || matches(h.content, src.model) || !matches(h.content, src.verified);
      if (!peopleHit) return { ...h, ...attach, provenance: 'earlier_ai_output' as const, provenanceBasis: aiHit ? ('source_match' as const) : ('heading' as const), content: label(historical) + h.content };
      // Both: each paragraph that is AI output is labelled where it stands; the rest reads as written.
      const content = h.content
        .split(/\n(?=\s*\n)|\n(?=- )/)
        .map((part) => (matches(part, ai) || COMPLETED.test(part) ? part.replace(/^(\s*(?:- )?)/, `$1${INLINE}`) : part))
        .join('\n');
      return { ...h, ...attach, provenance: 'contains_earlier_ai_output' as const, provenanceBasis: aiHit ? ('source_match' as const) : ('heading' as const), content };
    }
    if (peopleHit) return { ...h, provenance: 'document' as const, provenanceBasis: 'incident_record' as const };
    return { ...h, ...attach, provenance: 'unknown' as const, provenanceBasis: 'unmatched' as const, content: UNKNOWN_LABEL + h.content };
  });
}
