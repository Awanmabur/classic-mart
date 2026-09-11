import crypto from 'node:crypto';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzTimestamp(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function signAwsV4Request({
  method,
  url,
  body = Buffer.alloc(0),
  accessKeyId,
  secretAccessKey,
  region,
  service,
  now = new Date(),
}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('AWS SigV4 endpoint must use HTTPS.');
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const payloadHash = payload.length ? sha256(payload) : EMPTY_SHA256;
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = parsed.pathname
    .split('/')
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join('/') || '/';
  const canonicalQuery = [...parsed.searchParams.entries()]
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join('&');
  const canonicalHeaders = `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
}

export function awsUriEncode(value) {
  return rfc3986(value);
}
