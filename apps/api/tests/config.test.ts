import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Loads the environment module in a child process with the given variables. */
function loadEnv(overrides: Record<string, string>) {
  const base = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'a'.repeat(40),
    INTERNAL_SERVICE_TOKEN: 'b'.repeat(40),
    ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  return spawnSync('npx', ['tsx', '-e', "require('./src/config/env')"], { cwd: process.cwd(), env: { ...base, ...overrides }, encoding: 'utf8' });
}

describe('environment validation', () => {
  it('refuses to start in production with the published placeholder secrets', () => {
    const result = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-change-me-jwt-secret-0000000000000000', ENCRYPTION_KEY: '0'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('placeholder secrets: JWT_SECRET, ENCRYPTION_KEY');
  });

  it('accepts the placeholders in development and real secrets in production', () => {
    expect(loadEnv({ NODE_ENV: 'development', JWT_SECRET: 'dev-only-change-me-jwt-secret-0000000000000000' }).status).toBe(0);
    expect(loadEnv({ NODE_ENV: 'production' }).status).toBe(0);
  });

  it.each(['0', '-1', '1.5', '721', 'abc', ''])('refuses an approval validity of %j hours', (value) => {
    // An empty value is refused too, rather than silently replaced by the default.
    const result = loadEnv({ REMEDIATION_APPROVAL_VALIDITY_HOURS: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REMEDIATION_APPROVAL_VALIDITY_HOURS');
  });

  it('accepts an approval validity from 1 to 720 hours', () => {
    for (const value of ['1', '24', '720']) expect(loadEnv({ REMEDIATION_APPROVAL_VALIDITY_HOURS: value }).status).toBe(0);
  });

  it('refuses a stale-execution threshold that is not well above the webhook timeout', () => {
    const result = loadEnv({ REMEDIATION_EXECUTION_STALE_MINUTES: '2', REMEDIATION_WEBHOOK_TIMEOUT_MS: '120000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REMEDIATION_EXECUTION_STALE_MINUTES must be at least one minute longer than REMEDIATION_WEBHOOK_TIMEOUT_MS');
    expect(loadEnv({ REMEDIATION_EXECUTION_STALE_MINUTES: '0' }).status).not.toBe(0);
    expect(loadEnv({ REMEDIATION_EXECUTION_STALE_MINUTES: '3', REMEDIATION_WEBHOOK_TIMEOUT_MS: '120000' }).status).toBe(0);
  });

  it('names the variable that is malformed', () => {
    const result = loadEnv({ ENCRYPTION_KEY: 'too-short' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENCRYPTION_KEY must be 64 hex characters');
  });
});
