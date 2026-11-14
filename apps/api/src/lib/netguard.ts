import { lookup } from 'node:dns/promises';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { env, isTest } from '../config/env';
import { AppError, badRequest } from './errors';

/**
 * Guards requests to addresses that a tenant supplies (today: the remediation webhook)
 * against server-side request forgery.
 *
 * Checking a host name and then handing the same name to an HTTP client is not enough: the
 * client resolves the name again, and whoever controls the DNS record can answer the check
 * with a public address and the connection with a private one (DNS rebinding). So the check
 * happens where the connection is made: `safeRequest` connects through a lookup function
 * that resolves the name once, refuses the connection if any answer is disallowed, and hands
 * the socket exactly the addresses it checked. Every new connection, retries included, goes
 * through it again. The host name is still what TLS verifies the certificate against.
 */

type Resolved = { address: string; family: number };

export const netConfig = {
  /** Tests and local development can allow private targets; production deployments should not. */
  allowPrivate: env.REMEDIATION_WEBHOOK_ALLOW_PRIVATE,
  /** How a host name becomes addresses. Replaceable in tests, to play a DNS server that changes its answer. */
  resolve: (host: string): Promise<Resolved[]> => lookup(host, { all: true }),
  /** Addresses exempt from the block list, honoured only under NODE_ENV=test, so a test can reach a local server with the guard on. */
  allowedInTests: new Set<string>(),
};

const blocked = new BlockList();
// IPv4: this network, private, carrier-grade NAT, loopback, link-local (incl. cloud metadata),
// IETF protocol assignments, documentation, benchmarking, multicast, reserved, broadcast.
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
// IPv6: unspecified, loopback, unique local, link-local, site-local (deprecated), multicast,
// documentation, discard-only, and the ranges that embed an IPv4 address the IPv4 rules would
// have to judge (NAT64, 6to4, Teredo): refused outright rather than unpacked.
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP address is one OPSILUME must not call on a tenant's behalf. IPv4-mapped IPv6 is judged as the IPv4 address it carries. */
export function isDisallowedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (!family) return true; // not an address at all: nothing to connect to safely
  if (isTest && netConfig.allowedInTests.has(bare)) return false;
  return blocked.check(bare, family === 6 ? 'ipv6' : 'ipv4');
}

/** Raised when a destination is refused. Nothing was sent. */
export class UnsafeDestinationError extends AppError {
  constructor(message: string) {
    super(400, 'bad_request', message);
    this.name = 'UnsafeDestinationError';
  }
}

const REFUSED = 'That address is private, loopback or link-local. Webhooks must target a publicly routable host.';

/** Scheme, credentials and literal addresses: what can be judged from the text of the URL alone. */
function parseOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('The URL is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http and https URLs are allowed');
  if (url.username || url.password) throw badRequest('URLs with embedded credentials are not allowed');
  // The URL parser has already turned 127.1, 0x7f.1 and 2130706433 into 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!netConfig.allowPrivate && isIP(host) && isDisallowedAddress(host)) throw new UnsafeDestinationError(REFUSED);
  return url;
}

/** Resolves a host name and refuses it if any of its addresses is disallowed: one bad answer among good ones is enough. */
async function resolveChecked(host: string): Promise<Resolved[]> {
  let addresses: Resolved[];
  try {
    addresses = await netConfig.resolve(host);
  } catch {
    throw new UnsafeDestinationError(`The host "${host}" could not be resolved`);
  }
  if (!addresses.length) throw new UnsafeDestinationError(`The host "${host}" could not be resolved`);
  if (!netConfig.allowPrivate && addresses.some((a) => isDisallowedAddress(a.address))) throw new UnsafeDestinationError(REFUSED);
  return addresses;
}

/**
 * Early feedback when a URL is saved: is it well formed, and does its host resolve to public
 * addresses right now? This is advice to the person typing, not the protection: the answer
 * can change afterwards, which is why `safeRequest` checks again at the moment of connecting.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  const url = parseOutboundUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!netConfig.allowPrivate && !isIP(host)) await resolveChecked(host);
  return url;
}

/** The lookup every connection of `safeRequest` is made with: resolve, check, and connect only to what was checked. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  resolveChecked(hostname).then(
    (addresses) => {
      const wanted = typeof options === 'object' && options.family ? addresses.filter((a) => a.family === options.family) : addresses;
      const usable = wanted.length ? wanted : addresses;
      if (typeof options === 'object' && options.all) (callback as unknown as (err: null, addresses: Resolved[]) => void)(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    },
    (err: Error) => callback(err as NodeJS.ErrnoException, '', 0),
  );
};

const unsafeCause = (err: unknown): UnsafeDestinationError | null => {
  for (let e = err as { cause?: unknown; errors?: unknown[] } | undefined, depth = 0; e && depth < 6; e = e.cause as typeof e, depth++) {
    if (e instanceof UnsafeDestinationError) return e;
    const nested = (e.errors ?? []).find((x) => x instanceof UnsafeDestinationError);
    if (nested) return nested as UnsafeDestinationError;
  }
  return null;
};

/**
 * Sends one request to a tenant-supplied URL and returns only its status. The connection is
 * made to addresses that were checked in the act of connecting; redirects are not followed
 * (a redirect would be a second, unchecked destination); the response body is discarded
 * unread, so the answer of an internal service could not be relayed even if one were reached.
 *
 * Throws UnsafeDestinationError when the destination is refused: in that case nothing was
 * sent. Any other error means the request may have left.
 */
export async function safeRequest(raw: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; ok: boolean }> {
  const url = parseOutboundUrl(raw);
  // One agent per request: no connection is reused across requests, so none outlives the check it was made under.
  const agent = new Agent({ connect: { lookup: guardedLookup }, pipelining: 0 });
  try {
    const res = await undiciFetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: 'manual', dispatcher: agent, signal: AbortSignal.timeout(init.timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    throw unsafeCause(err) ?? err;
  } finally {
    void agent.destroy().catch(() => undefined);
  }
}
