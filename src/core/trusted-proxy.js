import { BlockList, isIP } from 'node:net';

/** Only explicit IPs/CIDRs; never infer trust from an HTTP forwarding header. */
export function trustedProxyMatcher(ranges = []) {
  const list = new BlockList();
  for (const entry of ranges) {
    const parts = String(entry).split('/');
    const family = isIP(parts[0]);
    const prefix = parts.length === 1 ? (family === 4 ? 32 : 128) : Number(parts[1]);
    if (!family || parts.length > 2 || !/^\d+$/.test(String(prefix))
      || !Number.isSafeInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error('Trusted proxy ranges must be explicit IP addresses or nonzero CIDRs.');
    }
    list.addSubnet(parts[0], prefix, family === 4 ? 'ipv4' : 'ipv6');
    // Node/containers commonly expose an IPv4 peer as an IPv4-mapped IPv6
    // address. Trust the mapped representation only for the exact same IPv4
    // subnet; this does not broaden the configured range.
    if (family === 4) list.addSubnet(`::ffff:${parts[0]}`, 96 + prefix, 'ipv6');
  }
  return address => {
    const family = isIP(address || '');
    return Boolean(family && list.check(address, family === 4 ? 'ipv4' : 'ipv6'));
  };
}
