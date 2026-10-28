import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { safeSourceUrl } from './news-sources.mjs';
import { webProblem } from './web-transport.mjs';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address,prefix,'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && /^[23]/i.test(address) && !blocked.check(address, 'ipv6');
}

export async function resolvePublicUrl(raw, { resolver = lookup, signal } = {}) {
  const safe = safeSourceUrl(raw);
  if (!safe) throw webProblem("Only public HTTPS sources are allowed", 400, 'unsafe_url');
  signal?.throwIfAborted();
  const records = await new Promise((resolve, reject) => {
    const abort = () => reject(webProblem("Web request cancelled or timed out", 408, 'aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => resolver(safe.host, { all: true, verbatim: true })).then(resolve, () => reject(webProblem("Source address resolution failed", 502, 'dns_failed')))
      .finally(() => signal?.removeEventListener('abort', abort));
  });
  signal?.throwIfAborted();
  if (!Array.isArray(records) || !records.length || records.some(r => !isPublicAddress(r.address))) {
    throw webProblem("Source resolves to a non-public network; access stopped", 400, 'unsafe_address');
  }
  return { ...safe, address: records[0].address, family: isIP(records[0].address) };
}

export async function fetchPublic(raw, { signal, headers, resolver, requester = request } = {}) {
  const target = await resolvePublicUrl(raw, { signal, resolver });
  return new Promise((resolve, reject) => {
    const req = requester(target.url, {
      method: 'GET', signal, headers, autoSelectFamily: false,
      lookup: (_host, options, done) => options?.all ? done(null, [{ address: target.address, family: target.family }]) : done(null, target.address, target.family),
    }, res => {
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
    });
    req.on('error', () => reject(webProblem("Public source connection incomplete. Retry later.", 502, 'transport_failed')));
    req.end();
  });
}
