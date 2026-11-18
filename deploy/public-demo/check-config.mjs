#!/usr/bin/env node
// Checks the rendered Compose configuration of the public demo for the properties its security depends
// on (docs/deployment/PUBLIC_DEMO_MODE.md). Renders with placeholder secrets; starts nothing.
//   node deploy/public-demo/check-config.mjs
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const placeholder = { DEMO_HOSTNAME: 'demo.example.org', POSTGRES_PASSWORD: 'p', JWT_SECRET: 'j', INTERNAL_SERVICE_TOKEN: 'i', ENCRYPTION_KEY: 'e' };
const json = execFileSync('docker', ['compose', '-f', join(here, 'compose.yml'), '--env-file', '/dev/null', 'config', '--format', 'json'], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST ?? '', ...placeholder },
  encoding: 'utf8',
});
const { services } = JSON.parse(json);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

for (const [name, s] of Object.entries(services)) {
  const published = (s.ports ?? []).map((p) => `${p.published}:${p.target}`);
  if (name === 'proxy') check(JSON.stringify(published.sort()) === JSON.stringify(['443:443', '80:80']), `proxy publishes ${published.join(', ')}, expected 80 and 443 only`);
  else check(published.length === 0, `${name} publishes ${published.join(', ')}; only the proxy may publish a port`);
  check(s.network_mode !== 'host', `${name} uses the host network`);
  check(!s.privileged, `${name} is privileged`);
  check(Boolean(s.mem_limit), `${name} has no memory limit`);
  check(!('PUBLIC_DEMO_OWNER_PASSWORD' in (s.environment ?? {})), `${name} is given PUBLIC_DEMO_OWNER_PASSWORD`);
}
for (const name of ['migrate', 'api', 'worker']) {
  const e = services[name].environment;
  check(e.PUBLIC_DEMO_MODE === 'true', `${name}: PUBLIC_DEMO_MODE is ${e.PUBLIC_DEMO_MODE}`);
  check(e.COOKIE_SECURE === 'true', `${name}: COOKIE_SECURE is ${e.COOKIE_SECURE}`);
  check(e.TRUST_PROXY === 'uniquelocal', `${name}: TRUST_PROXY is ${e.TRUST_PROXY}`);
  check(Number(e.INVESTIGATION_TIMEOUT_MS) > 0 && Number(e.INVESTIGATION_TIMEOUT_MS) <= 300_000, `${name}: INVESTIGATION_TIMEOUT_MS is ${e.INVESTIGATION_TIMEOUT_MS}; at most 5 minutes in the demo`);
  check(['INVESTIGATION_DAILY_LIMIT', 'INVESTIGATION_MAX_CONCURRENT', 'DEMO_SESSION_INVESTIGATION_LIMIT', 'DEMO_ADDRESS_DAILY_INVESTIGATION_LIMIT'].every((k) => Number(e[k]) > 0), `${name}: investigation limits are not all set`);
}
const ai = services.ai.environment;
check(ai.AI_PROVIDER === 'deterministic', `ai: AI_PROVIDER is ${ai.AI_PROVIDER}`);
for (const key of Object.keys(ai).filter((k) => /API_KEY$/.test(k))) check(ai[key] === '', `ai: ${key} is set`);

if (failures.length) {
  process.stderr.write(`Public demo configuration check FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Public demo configuration check passed: ${Object.keys(services).length} services; only the proxy publishes ports (80, 443); demo mode, Secure cookies, proxy trust and the rule-based engine are set; no owner password; every service has a memory limit.\n`);
