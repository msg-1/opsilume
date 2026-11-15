import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyGuardrails, reportSchema } from '../src/modules/investigations';

/** Every key path in a JSON value, with list items collapsed. */
function shape(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) for (const p of shape(item, `${prefix}[].`)) out.add(p);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(`${prefix}${k}`);
      for (const p of shape(v, `${prefix}${k}.`)) out.add(p);
    }
  }
  return out;
}

describe('report contract with the AI service', () => {
  // Written by the AI service's own test suite from a real investigation run
  // (services/ai/tests/test_agent.py). Both suites read the same file, so the two
  // definitions of the report cannot drift apart unnoticed.
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../contracts/fixtures/report.contract.json'), 'utf8'));

  it('accepts what the AI service actually emits', () => {
    const parsed = reportSchema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keeps every field the AI service sends', () => {
    const parsed = reportSchema.parse(fixture);
    // Parameters are free-form on the API side; everything else must survive parsing.
    const sent = [...shape(fixture)].filter((p) => !p.startsWith('recommendedActions.[].parameters.'));
    const kept = shape(parsed);
    expect(sent.filter((p) => !kept.has(p))).toEqual([]);
  });
});

// ───────────────────────── contracts/ : one definition, checked on this side ─────────────────────────

const CONTRACTS = join(__dirname, '../../../contracts');
const readContract = (name: string) => {
  const { $comment: _comment, ...data } = JSON.parse(readFileSync(join(CONTRACTS, name), 'utf8'));
  return data;
};

type Json = Record<string, unknown>;

/**
 * Flattens a JSON Schema into "path → allowed values". References are followed, nullable
 * unions are unwrapped, and list items appear as "[]", so two schemas written by different
 * tools (pydantic, Zod) can be compared by what they describe.
 */
function describeSchema(root: Json): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  const resolve = (node: Json): Json => {
    let n = node;
    for (let i = 0; i < 20; i++) {
      if (typeof n.$ref === 'string') n = (root.$defs as Record<string, Json>)[n.$ref.split('/').pop()!]!;
      else if (Array.isArray(n.anyOf)) n = (n.anyOf as Json[]).find((a) => a.type !== 'null') ?? {};
      else break;
    }
    return n;
  };
  const walk = (node: Json, path: string) => {
    const n = resolve(node);
    if (path) out.set(path, Array.isArray(n.enum) ? (n.enum as string[]).map(String) : n.const !== undefined ? [String(n.const)] : null);
    if (n.type === 'array' && n.items) walk(n.items as Json, `${path}.[]`);
    for (const [key, child] of Object.entries((n.properties ?? {}) as Record<string, Json>)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(root, '');
  return out;
}

describe('shared contracts', () => {
  it('the generated TypeScript is what contracts/*.json define', async () => {
    const generated = (await import('../src/generated/contracts')) as unknown as Record<string, unknown>;
    for (const [name, values] of Object.entries(readContract('enums.json'))) {
      const constant = name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
      expect(generated[constant], name).toEqual(values);
    }
    expect(generated.GUARDRAIL_LIMITS).toEqual(readContract('guardrails.json'));
    expect(generated.ACTION_EFFECT_RULES).toEqual(readContract('action-effects.json'));
  });

  it('the unestablished-cause cap is shared and sits strictly below the likely threshold', async () => {
    const { GUARDRAIL_LIMITS } = await import('../src/generated/contracts');
    const json = readContract('guardrails.json') as { unestablishedCauseCap: number; likelyMinimumConfidence: number };
    expect(GUARDRAIL_LIMITS.unestablishedCauseCap).toBe(json.unestablishedCauseCap);
    expect(GUARDRAIL_LIMITS.unestablishedCauseCap).toBeLessThan(GUARDRAIL_LIMITS.likelyMinimumConfidence);
  });

  it("the API's report schema describes the same report as the AI service's", () => {
    const theirs = describeSchema(readContract('report.schema.json'));
    const ours = describeSchema(z.toJSONSchema(reportSchema, { io: 'input' }) as Json);
    // Action parameters are typed in the AI service and free-form here, on purpose.
    const paths = (m: Map<string, unknown>) => [...m.keys()].filter((p) => !p.startsWith('recommendedActions.[].parameters.')).sort();
    expect(paths(ours).filter((p) => !theirs.has(p)), 'fields the API accepts that the AI service never sends').toEqual([]);
    expect(paths(theirs).filter((p) => !ours.has(p)), 'fields the AI service sends that the API would drop').toEqual([]);
    // Wherever either side restricts a field to a closed set, both must allow the same values.
    const differing = paths(theirs).filter((p) => (theirs.get(p) || ours.get(p)) && JSON.stringify([...(theirs.get(p) ?? [])].sort()) !== JSON.stringify([...(ours.get(p) ?? [])].sort()));
    expect(differing.map((p) => `${p}: AI ${JSON.stringify(theirs.get(p))} vs API ${JSON.stringify(ours.get(p))}`)).toEqual([]);
    expect(theirs.size).toBeGreaterThan(60);
  });

  interface GuardrailCase {
    name: string;
    evidence: { ref: string; kind: string; sourceId: string }[];
    report: unknown;
    expect: {
      actions: [string, string][];
      nextStepsContain?: string[];
      nextStepsNotContain?: string[];
      effects?: Record<string, string>;
      hypotheses?: { title: string; status?: string; notStatus?: string; evidenceRefs: string[]; maxConfidence: number }[];
      maxConfidence?: number;
      facts?: string[];
      assumptionsContain?: string[];
    };
  }
  const { cases } = readContract('fixtures/guardrail-cases.json') as { cases: GuardrailCase[] };

  // The API re-applies these rules to whatever the AI service returned. The same cases are
  // run by the AI service against its own implementation (services/ai/tests/test_contracts.py).
  it.each(cases.map((c) => [c.name, c] as const))('guardrail case: %s', async (_name, c) => {
    const known = new Set(c.evidence.map((e) => e.ref));
    const deployments = new Map(c.evidence.filter((e) => e.kind === 'deployment').map((e) => [e.sourceId, e.ref]));
    const result = await applyGuardrails(reportSchema.parse(c.report), known, async () => undefined, deployments);
    const e = c.expect;
    expect(result.recommendedActions.map((a) => [a.type, a.title])).toEqual(e.actions);
    for (const text of e.nextStepsContain ?? []) expect(result.nextSteps.some((s) => s.includes(text)), result.nextSteps.join(' | ')).toBe(true);
    for (const text of e.nextStepsNotContain ?? []) expect(result.nextSteps.some((s) => s.includes(text))).toBe(false);
    for (const [title, effect] of Object.entries(e.effects ?? {})) expect(result.recommendedActions.find((a) => a.title === title)?.effect).toBe(effect);
    if (e.hypotheses) {
      expect(result.hypotheses.map((h) => h.title)).toEqual(e.hypotheses.map((h) => h.title));
      for (const [i, h] of e.hypotheses.entries()) {
        const actual = result.hypotheses[i]!;
        expect(actual.evidenceRefs).toEqual(h.evidenceRefs);
        expect(actual.confidence).toBeLessThanOrEqual(h.maxConfidence);
        if (h.status) expect(actual.status).toBe(h.status);
        if (h.notStatus) expect(actual.status).not.toBe(h.notStatus);
      }
    }
    if (e.maxConfidence !== undefined) expect(result.confidence).toBeLessThanOrEqual(e.maxConfidence);
    if (e.facts) expect(result.facts.map((f) => f.statement)).toEqual(e.facts);
    for (const text of e.assumptionsContain ?? []) expect(result.assumptions).toContain(text);
  });

  // The outcome rules at the API boundary, beyond the shared case. Only the assessment counts as a
  // verified outcome: it is computed by the AI service's code, while the report's own `outcome` is
  // its author's claim. These cases are API-only: the AI service recomputes the assessment from
  // the evidence, so a report without one cannot arise there.
  const degraded = cases.find((c) => c.name.startsWith('under DEGRADED'))!;
  const known = new Set(degraded.evidence.map((e) => e.ref));
  const assessed = (outcome: string) => ({ outcome, confidence: 0.9, rationale: 'r', supportingRefs: [], signals: [], missingTelemetry: [] });
  const restart = { type: 'restart_service', title: 'Restart orders', description: 'Restart the pods.', risk: 'LOW', serviceSlug: 'orders', evidenceRefs: ['E1'] };
  const run = async (change: (r: Record<string, unknown>) => void) => {
    const report = structuredClone(degraded.report) as Record<string, unknown>;
    report.hypotheses = (report.hypotheses as Record<string, unknown>[]).map((h, i) => (i === 0 ? { ...h, confidence: 0.8, status: 'likely' } : h));
    report.confidence = 0.8;
    report.recommendedActions = [restart];
    change(report);
    const steps: { detail?: string | null }[] = [];
    const result = await applyGuardrails(reportSchema.parse(report), known, async (s) => steps.push(s));
    return { result, notes: steps.map((s) => s.detail).join('\n') };
  };

  it('no assessment, claimed INCIDENT: the claim is not trusted, the likely cause is capped and no production change is offered', async () => {
    const { result, notes } = await run((r) => { delete r.assessment; r.outcome = 'INCIDENT'; });
    expect(result.hypotheses.map((h) => [h.status, h.confidence])).toEqual([['possible', 0.45], ['possible', 0.3]]);
    expect(result.confidence).toBe(0.45);
    expect(result.outcome).toBeNull();
    expect(result.recommendedActions).toEqual([]);
    expect(result.nextSteps.some((s) => s.includes('the report carries no assessment of the evidence') && s.includes('Restart orders'))).toBe(true);
    expect(notes).toContain('The report states the outcome INCIDENT, but it carries no assessment of the evidence');
    expect(notes).toContain('the report carries no assessment of the evidence, so no cause is verified');
    expect(result.uncertainties).toContain('This report arrived without an assessment of the evidence, so its outcome is not verified.');
  });

  it('no assessment, claimed DEGRADED: capped the same way, and said to be unverified rather than DEGRADED', async () => {
    const { result, notes } = await run((r) => { delete r.assessment; r.outcome = 'DEGRADED'; });
    expect(result.hypotheses[0]).toMatchObject({ status: 'possible', confidence: 0.45 });
    expect(result.outcome).toBeNull();
    expect(result.recommendedActions).toEqual([]);
    expect(notes).toContain('no cause is verified');
    expect(notes).not.toContain('the outcome is DEGRADED, so the cause is not established');
  });

  it('verified INCIDENT: a likely hypothesis and its production change stand, whatever the report claims', async () => {
    const { result, notes } = await run((r) => { r.assessment = assessed('INCIDENT'); r.outcome = 'DEGRADED'; });
    expect(result.hypotheses[0]).toMatchObject({ status: 'likely', confidence: 0.8 });
    expect(result.confidence).toBe(0.8);
    expect(result.outcome).toBe('INCIDENT');
    expect(result.recommendedActions.map((a) => a.title)).toEqual(['Restart orders']);
    expect(notes).not.toContain('no assessment');
  });

  it('verified DEGRADED: capped with the DEGRADED reason, even when the report claims an incident', async () => {
    const { result, notes } = await run((r) => { r.assessment = assessed('DEGRADED'); r.outcome = 'INCIDENT'; });
    expect(result.hypotheses.map((h) => [h.status, h.confidence])).toEqual([['possible', 0.45], ['possible', 0.3]]);
    expect(result.confidence).toBe(0.45);
    expect(result.outcome).toBe('DEGRADED');
    expect(result.recommendedActions).toEqual([]);
    expect(notes).toContain('the outcome is DEGRADED, so the cause is not established');
    expect(result.uncertainties).not.toContain('This report arrived without an assessment of the evidence, so its outcome is not verified.');
  });
});

// ───────────────────────── The tool API, as the AI service uses it ─────────────────────────

describe('tool contract with the AI service', () => {
  interface Tool { name: string; method: string; path: string; pathParameters: string[]; query: string[]; body: string[]; reads: string[] }
  const contract = readContract('tools.json') as { basePath: string; tools: Tool[] };

  it('every tool the agent can call exists, accepts the parameters it sends and returns the fields it reads', async () => {
    const { api, createApiKey, createOrg, createService, minutesAgo, prisma } = await import('./helpers');
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    const key = await createApiKey(org.owner, ['tools:read', 'ingest:logs', 'ingest:metrics']);
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.0.0', startedAt: minutesAgo(600) }).expect(201);
    const deployed = (await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.1.0', startedAt: minutesAgo(20) }).expect(201)).body;
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing after deploy', serviceIds: [service.id] }).expect(201)).body;
    await api().post('/api/v1/logs').set('x-api-key', key).send({ service: 'checkout', logs: [{ level: 'error', message: 'timeout acquiring connection', timestamp: minutesAgo(5) }] }).expect(202);
    await api().post('/api/v1/monitoring/metrics').set('x-api-key', key).send({ samples: [{ service: 'checkout', metric: 'error_rate', value: 4.2 }] }).expect(202);
    expect(await prisma.incident.count({ where: { organizationId: org.organizationId } })).toBe(1);

    // A plausible value for every parameter name the AI service sends.
    const value: Record<string, string | number> = { service: 'checkout', from: '2h', to: new Date().toISOString(), limit: 5, level: 'ERROR', q: 'timeout', traceId: 'trace-1', metric: 'error_rate', deploymentId: deployed.id, errorsOnly: 'true', query: 'connection timeout' };
    const pathValue: Record<string, string> = { service: 'checkout', incident: incident.id };
    const problems: string[] = [];
    for (const tool of contract.tools) {
      const path = tool.path.replace(/{(\w+)}/g, (_m, name: string) => pathValue[name]!);
      const unknown = [...tool.query, ...tool.body].filter((p) => !(p in value));
      if (unknown.length) problems.push(`${tool.name}: this test has no value for ${unknown.join(', ')}`);
      const request = tool.method === 'GET'
        ? api().get(`/api/v1/tools${path}`).query(Object.fromEntries(tool.query.map((p) => [p, value[p]!])))
        : api().post(`/api/v1/tools${path}`).send(Object.fromEntries(tool.body.map((p) => [p, value[p]!])));
      const res = await request.set('x-api-key', key);
      if (res.status !== 200) {
        problems.push(`${tool.name}: ${tool.method} ${path} answered ${res.status} ${JSON.stringify(res.body?.error ?? {})}`);
        continue;
      }
      const missing = tool.reads.filter((field) => !(field in res.body));
      if (missing.length) problems.push(`${tool.name}: the response lacks ${missing.join(', ')}, which the AI service reads`);
    }
    expect(problems).toEqual([]);
    expect(contract.tools.length).toBeGreaterThanOrEqual(15);
    // Read-only by construction: the contract contains no method that could write, other than the search.
    expect(contract.tools.filter((t) => t.method !== 'GET').map((t) => t.name)).toEqual(['search_knowledge_base']);
  });
});
