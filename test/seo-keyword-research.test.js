import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertResearchUrl, catalogueCandidates, collectResearch, parseSuggestions,
  parseTrends, relevanceFor, renderResearchMarkdown, researchUrl, robotsPolicy,
} from '../scripts/seo-keyword-research.js';

const textResponse = (body, type = 'text/plain', status = 200, extraHeaders = {}) => new Response(body, { status, headers: { 'content-type': type, ...extraHeaders } });
const noWait = async () => {};

test('research destinations accept only fixed official routes, supported markets and catalogue queries', () => {
  for (const source of ['google', 'bing', 'trends']) assert.doesNotThrow(() => assertResearchUrl(researchUrl(source, 'UG', 'wireless headphones')));
  for (const input of [
    'http://www.google.com/robots.txt', 'https://localhost/robots.txt',
    'https://127.0.0.1/robots.txt', 'https://www.google.com.attacker.test/robots.txt',
    'https://user:password@www.google.com/robots.txt', 'https://www.google.com:444/robots.txt',
    'https://www.google.com/search?q=wireless+headphones', 'https://www.google.com/robots.txt?x=1',
    `${researchUrl('google', 'UG', 'wireless headphones')}&callback=anything`,
    'https://trends.google.com/trending/rss?geo=US',
  ]) assert.throws(() => assertResearchUrl(input), undefined, input);
  assert.throws(() => researchUrl('google', 'UG', 'arbitrary query'));
  assert.throws(() => researchUrl('google', 'ZA', 'wireless headphones'));
});

test('robots policy selects matching agent groups and most specific rule with Allow ties', () => {
  const robots = 'User-agent: *\nDisallow: /\nUser-agent: ClassicMartKeywordResearch\nDisallow: /complete/\nAllow: /complete/search?client=firefox\nCrawl-delay: 2\n';
  assert.deepEqual(robotsPolicy(robots, researchUrl('google', 'UG', 'wireless headphones')), { allowed: true, crawlDelayMs: 2000 });
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /complete/*\nAllow: /complete/*\n', researchUrl('google', 'UG', 'wireless headphones')).allowed, true);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /robots.txt$\n', 'https://www.google.com/robots.txt').allowed, false);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /robots.txt$\n', 'https://www.google.com/robots.txt?x=1').allowed, true);
  assert.throws(() => robotsPolicy('<html>captcha</html>', 'https://www.google.com/robots.txt'));
});

test('RSS parsing preserves provider labels as statements and rejects entity declarations', () => {
  const xml = '<rss><channel><item><title><![CDATA[wireless headphones & speakers]]></title><ht:approx_traffic>2K+</ht:approx_traffic><pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate></item><item><title>Running &amp; shoes</title></item></channel></rss>';
  const items = parseTrends(xml);
  assert.equal(items[0].term, 'wireless headphones & speakers');
  assert.equal(items[0].providerTrafficLabel, '2K+');
  assert.match(items[0].evidenceType, /not monthly volume/);
  assert.equal(items[1].term, 'Running & shoes');
  assert.throws(() => parseTrends('<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>'));
});

test('suggestions are bounded unique plain text and require a recognized response shape', () => {
  assert.deepEqual(parseSuggestions(JSON.stringify(['headphones', ['<b>wireless headphones</b>', 'wireless headphones', null, 7]])), ['wireless headphones']);
  assert.throws(() => parseSuggestions('{"message":"captcha"}'));
  assert.throws(() => parseSuggestions('<html>blocked</html>'));
});

test('relevance requires a concrete catalogue product noun', () => {
  assert.equal(relevanceFor('smart election results').length, 0);
  assert.equal(relevanceFor('wireless network outage').length, 0);
  assert.equal(relevanceFor('travel news').length, 0);
  assert.ok(relevanceFor('wireless headphones prices uganda').some(({ candidate }) => candidate === 'wireless headphones'));
  assert.equal(relevanceFor('skin cancer news').length, 0);
  assert.ok(relevanceFor('skin care set').some(({ candidate }) => candidate === 'skin care set'));
  assert.ok(relevanceFor('smart watches uganda').some(({ candidate }) => candidate === 'smart watch'));
  assert.ok(catalogueCandidates().every(({ basis }) => /unverified/.test(basis)));
});

test('unavailable robots stops that source without attempting the endpoint or retrying', async () => {
  const requested = [];
  const report = await collectResearch({ sources: ['google', 'trends'], waitImpl: noWait, fetchImpl: async (url) => { requested.push(url); return textResponse('Forbidden', 'text/plain', 403); } });
  assert.deepEqual(requested, ['https://www.google.com/robots.txt', 'https://trends.google.com/robots.txt']);
  assert.equal(report.evidence.length, 0);
  assert.ok(report.observations.every(({ reason }) => reason === 'HTTP 403'));
});

test('disallowed suggestion paths are not requested', async () => {
  const requested = [];
  const report = await collectResearch({ limit: 1, waitImpl: noWait, fetchImpl: async (url) => { requested.push(url); return textResponse('User-agent: *\nDisallow: /complete/'); } });
  assert.equal(requested.length, 1);
  assert.equal(report.observations.at(-1).outcome, 'skipped');
  assert.equal(report.evidence.length, 0);
});

test('successful collection keeps source, requested market, UTC timestamp and factual evidence label', async () => {
  const waits = [];
  const report = await collectResearch({ country: 'KE', limit: 1, waitImpl: async (milliseconds) => waits.push(milliseconds), fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/robots.txt')) return textResponse('User-agent: *\nDisallow: /search\nCrawl-delay: 2');
    return textResponse(JSON.stringify(['wireless headphones', ['wireless headphones price', 'unrelated election news']]), 'application/json');
  } });
  assert.equal(report.requestsMade, 2);
  assert.equal(report.evidence.length, 1);
  assert.equal(report.evidence[0].country, 'KE');
  assert.equal(report.evidence[0].sourceUrl, researchUrl('google', 'KE', 'wireless headphones'));
  assert.match(report.evidence[0].observedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(report.evidence[0].evidenceType, /not frequency, rank, volume/);
  assert.ok(waits[0] >= 1900);
});

test('redirects and oversized responses fail closed and stop subsequent queries', async () => {
  for (const kind of ['redirect', 'large']) {
    let count = 0;
    const report = await collectResearch({ limit: 4, waitImpl: noWait, fetchImpl: async (url) => {
      count += 1;
      if (url.endsWith('/robots.txt')) return textResponse('User-agent: *\nAllow: /');
      if (kind === 'redirect') return textResponse('', 'application/json', 302, { location: 'http://127.0.0.1/internal' });
      return textResponse('[]', 'application/json', 200, { 'content-length': '524289' });
    } });
    assert.equal(count, 2);
    assert.equal(report.evidence.length, 0);
    assert.equal(report.observations.at(-1).outcome, 'unavailable');
  }
});

test('streamed response limits apply even without Content-Length', async () => {
  const report = await collectResearch({ limit: 1, waitImpl: noWait, fetchImpl: async (url) => url.endsWith('/robots.txt')
    ? textResponse('User-agent: *\nAllow: /')
    : textResponse('x'.repeat(524289), 'application/json') });
  assert.equal(report.evidence.length, 0);
  assert.match(report.observations.at(-1).reason, /byte limit/);
});

test('Markdown escapes remote wording and never implies quantified demand', async () => {
  const report = await collectResearch({ limit: 1, waitImpl: noWait, fetchImpl: async (url) => url.endsWith('/robots.txt')
    ? textResponse('User-agent: *\nAllow: /')
    : textResponse(JSON.stringify(['wireless headphones', ['wireless headphones [click](bad)|<script>evil</script>']]), 'application/json') });
  const markdown = renderResearchMarkdown(report);
  assert.match(markdown, /not search frequencies/);
  assert.match(markdown, /\[click\\\]/);
  assert.doesNotMatch(markdown, /<script>/);
});

test('seed offsets reach the remaining catalogue products without accepting arbitrary queries', async () => {
  const requested = [];
  await collectResearch({ limit: 1, offset: 4, waitImpl: noWait, fetchImpl: async (url) => {
    requested.push(url);
    return url.endsWith('/robots.txt') ? textResponse('User-agent: *\nAllow: /') : textResponse(JSON.stringify(['running shoes', ['running shoes']]), 'application/json');
  } });
  assert.equal(requested[1], researchUrl('google', 'UG', 'running shoes'));
  await assert.rejects(collectResearch({ offset: 12 }));
});
