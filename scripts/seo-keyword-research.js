/** Optional public-source research. Never imported by the application or used to publish metadata. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGlobalProxyFromEnv } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { supportedCountries, marketplaceCategories } from '../src/config/marketplace-reference.js';
import { initialProducts } from '../src/config/initial-catalogue.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const USER_AGENT = 'ClassicMartKeywordResearch/1.0';
const COUNTRIES = new Set(supportedCountries.map(({ code }) => code));
const SOURCES = new Set(['trends', 'google', 'bing']);
const MAX_BYTES = 512 * 1024;
const MAX_REQUESTS = 12;
const REQUEST_MS = 10_000;
const RUN_MS = 90_000;
const MIN_INTERVAL_MS = 1500;
const HOSTS = new Set(['trends.google.com', 'www.google.com', 'www.bing.com']);

export function catalogueCandidates() {
  return initialProducts.map((product) => ({
    term: product.key.replaceAll('-', ' '),
    productTitle: product.title,
    category: product.category,
    basis: 'starter catalogue definition; current publication, availability and demand unverified',
  }));
}

export function researchUrl(source, country, term) {
  if (!SOURCES.has(source) || !COUNTRIES.has(country)) throw new Error('Unsupported source or marketplace country.');
  const url = new URL(source === 'trends' ? 'https://trends.google.com/trending/rss' : source === 'google' ? 'https://www.google.com/complete/search' : 'https://www.bing.com/osjson.aspx');
  if (source === 'trends') url.searchParams.set('geo', country);
  else {
    if (!catalogueCandidates().some((candidate) => candidate.term === term)) throw new Error('Query must be a catalogue candidate.');
    if (source === 'google') {
      url.searchParams.set('client', 'firefox');
      url.searchParams.set('hl', 'en');
      url.searchParams.set('gl', country.toLowerCase());
      url.searchParams.set('q', term);
    } else {
      url.searchParams.set('market', `en-${country}`);
      url.searchParams.set('query', term);
    }
  }
  return url.href;
}

export function assertResearchUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !HOSTS.has(url.hostname)) throw new Error('Unapproved research URL.');
  if (url.pathname === '/robots.txt' && !url.search) return url;
  for (const country of COUNTRIES) {
    if (url.href === researchUrl('trends', country)) return url;
    for (const source of ['google', 'bing']) {
      for (const candidate of catalogueCandidates()) {
        if (url.href === researchUrl(source, country, candidate.term)) return url;
      }
    }
  }
  throw new Error('Unapproved research path, query or parameters.');
}

/** RFC 9309 style longest-match Allow/Disallow, wildcard and end-anchor support. */
export function robotsPolicy(text, input) {
  if (/<(?:!doctype|html)/i.test(text)) throw new Error('Robots response is HTML.');
  const groups = [];
  let group = null;
  let hasRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (!group || hasRules) {
        group = { agents: [], rules: [], crawlDelayMs: 0 };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(field)) {
      hasRules = true;
      if (field === 'crawl-delay') {
        if (/^\d+(\.\d+)?$/.test(value)) group.crawlDelayMs = Math.max(group.crawlDelayMs, Number(value) * 1000);
      } else if (value) group.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  const agent = USER_AGENT.split('/')[0].toLowerCase();
  const specificity = (entry) => Math.max(-1, ...entry.agents.map((name) => name === '*' ? 0 : agent.includes(name) ? name.length : -1));
  const best = Math.max(-1, ...groups.map(specificity));
  const selected = groups.filter((entry) => specificity(entry) === best && best >= 0);
  const url = new URL(input);
  const target = `${url.pathname}${url.search}`;
  let winner = { allow: true, length: -1 };
  for (const entry of selected) {
    for (const rule of entry.rules) {
      const end = rule.pattern.endsWith('$');
      const pattern = end ? rule.pattern.slice(0, -1) : rule.pattern;
      const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${end ? '$' : ''}`);
      const length = pattern.replaceAll('*', '').length;
      if (regex.test(target) && (length > winner.length || (length === winner.length && rule.allow))) winner = { allow: rule.allow, length };
    }
  }
  return { allowed: winner.allow, crawlDelayMs: Math.max(0, ...selected.map((entry) => entry.crawlDelayMs)) };
}

function cleanText(value, maximum = 200) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function decodeXml(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, number, named) => {
    if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
    const point = number[0].toLowerCase() === 'x' ? Number.parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

export function parseTrends(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss[\s>]/i.test(xml)) throw new Error('Unsupported RSS document.');
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 50).map((match) => {
    const field = (tag) => cleanText(decodeXml(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(match[1])?.[1] || ''));
    return { term: field('title'), providerTrafficLabel: field('ht:approx_traffic'), publishedAt: field('pubDate'), evidenceType: 'provider trending-feed item; not monthly volume or marketplace demand' };
  }).filter((item) => item.term);
}

export function parseSuggestions(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('Unsupported suggestion response.');
  return [...new Set(data[1].filter((entry) => typeof entry === 'string').map((entry) => cleanText(entry)).filter(Boolean))].slice(0, 20);
}

export function relevanceFor(term) {
  const singular = (word) => word.endsWith('ches') || word.endsWith('shes') ? word.slice(0, -2) : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  const phrase = cleanText(term).toLowerCase();
  const words = new Set((phrase.match(/[a-z0-9]+/g) || []).map(singular));
  // Require a concrete product noun; a generic adjective such as "smart" is insufficient.
  const ignored = new Set(['classic', 'generic', 'city', 'active', 'daily', 'everyday', 'essential', 'premium', 'organized', 'quiet', 'adjustable', 'compact', 'foldable', 'sealed', 'set', 'care', 'wireless', 'portable', 'travel', 'learning', 'office', 'skin', 'vehicle', 'baby', 'smart', 'table', 'running']);
  return catalogueCandidates().filter((candidate) => candidate.term === 'skin care set' ? /\bskin care\b/.test(phrase) : candidate.term.split(' ').some((word) => !ignored.has(word) && words.has(singular(word)))).map(({ term: candidate, productTitle, category }) => ({ candidate, productTitle, category }));
}

function summarizeError(error) {
  // Preserve status codes, never proxy URLs, authentication data, response bodies or remote exception text.
  let cause = error;
  for (let depth = 0; cause && depth < 3; depth += 1, cause = cause.cause) {
    const status = /\b(?:HTTP|status(?: code)?|Proxy response)\s*\(?(\d{3})/i.exec(cause.message || '')?.[1];
    if (status) return `HTTP ${status}`;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Request or run deadline exceeded.';
  if (/redirect/i.test(error.message || '')) return 'Redirect refused.';
  if (/byte|large|length/i.test(error.message || '')) return 'Response exceeds byte limit.';
  if (/content.type|document|response|RSS|JSON/i.test(error.message || '')) return 'Unexpected source response.';
  return 'Network or source policy failure; no source data collected.';
}

export async function collectResearch({ country = 'UG', sources = ['google'], limit = 4, offset = 0, fetchImpl = fetch, waitImpl = delay, now = () => Date.now() } = {}) {
  if (!COUNTRIES.has(country) || !Number.isInteger(limit) || limit < 1 || limit > 4 || !Number.isInteger(offset) || offset < 0 || offset >= initialProducts.length || sources.length < 1 || sources.length > 3 || new Set(sources).size !== sources.length || sources.some((source) => !SOURCES.has(source))) throw new Error('Unsupported country, sources, offset or limit (1–4).');
  const startedAt = now();
  const candidates = catalogueCandidates();
  const observations = [];
  const records = [];
  let requests = 0;
  let lastRequestAt = -Infinity;
  const runController = new AbortController();
  const runTimer = setTimeout(() => runController.abort(), RUN_MS);
  const read = async (input, accept, intervalMs = MIN_INTERVAL_MS, robots = false) => {
    const url = assertResearchUrl(input);
    const remaining = RUN_MS - (now() - startedAt);
    if (requests >= MAX_REQUESTS || remaining <= 0) throw new Error('Request or run deadline exceeded.');
    const wait = Math.max(0, intervalMs - (now() - lastRequestAt));
    if (wait >= remaining) throw new Error('Request or run deadline exceeded.');
    if (wait) await waitImpl(wait, undefined, { signal: runController.signal });
    requests += 1;
    lastRequestAt = now();
    const observedAt = new Date(lastRequestAt).toISOString();
    const signal = AbortSignal.any([runController.signal, AbortSignal.timeout(Math.min(REQUEST_MS, Math.max(1, RUN_MS - (now() - startedAt))))]);
    let response;
    try {
      response = await fetchImpl(url.href, { signal, redirect: 'error', headers: { 'User-Agent': USER_AGENT, Accept: accept } });
      if (response.status >= 300 && response.status < 400) throw new Error('Redirect refused.');
      if (robots && [404, 410].includes(response.status)) {
        await response.body?.cancel();
        observations.push({ url: url.href, observedAt, status: response.status, outcome: 'robots file absent; standard allow policy' });
        return '';
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url && response.url !== url.href) throw new Error('Redirect refused.');
      if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Response too large.');
      const type = response.headers.get('content-type') || '';
      if (!(robots ? /^text\/plain/i : /(?:xml|rss|json|javascript)/i).test(type)) throw new Error('Unexpected content type.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error('Response exceeds byte limit.');
        chunks.push(Buffer.from(chunk));
      }
      observations.push({ url: url.href, observedAt, status: response.status, outcome: 'received', bytes });
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      observations.push({ url: url.href, observedAt, status: response?.status || null, outcome: 'unavailable', reason: summarizeError(error) });
      throw error;
    }
  };
  try {
    for (const source of sources) {
      const firstUrl = researchUrl(source, country, candidates[0].term);
      const robotsUrl = `${new URL(firstUrl).origin}/robots.txt`;
      let policy;
      try { policy = await read(robotsUrl, 'text/plain', MIN_INTERVAL_MS, true); }
      catch (error) {
        if (observations.at(-1)?.url !== robotsUrl) observations.push({ url: robotsUrl, observedAt: new Date(now()).toISOString(), status: null, outcome: 'unavailable', reason: summarizeError(error) });
        continue; // Fail closed; no alternate host, captcha workaround, or retries.
      }
      const terms = source === 'trends' ? [null] : candidates.slice(offset, offset + limit).map(({ term }) => term);
      for (const seedTerm of terms) {
        const url = researchUrl(source, country, seedTerm);
        try {
          const rule = robotsPolicy(policy, url);
          if (!rule.allowed || rule.crawlDelayMs > 10_000) {
            observations.push({ url, observedAt: new Date(now()).toISOString(), status: null, outcome: 'skipped', reason: rule.allowed ? 'Source crawl delay exceeds bounded research budget.' : 'robots.txt disallows this path.' });
            continue;
          }
          const payload = await read(url, source === 'trends' ? 'application/rss+xml, application/xml, text/xml' : 'application/json, text/javascript', Math.max(MIN_INTERVAL_MS, rule.crawlDelayMs));
          const observedAt = observations.at(-1).observedAt;
          const items = source === 'trends' ? parseTrends(payload) : parseSuggestions(payload).map((term) => ({ term, evidenceType: 'observed autocomplete wording; not frequency, rank, volume or a trend' }));
          records.push(...items.map((item) => ({ ...item, source, country, sourceUrl: url, observedAt, seedTerm, relevance: relevanceFor(item.term) })).filter((item) => item.relevance.length));
        } catch (error) {
          if (observations.at(-1)?.url !== url || observations.at(-1)?.outcome !== 'unavailable') observations.push({ url, observedAt: new Date(now()).toISOString(), status: null, outcome: 'unavailable', reason: summarizeError(error) });
          break; // Do not repeat a denial, timeout, invalid response or source error.
        }
      }
    }
  } finally { clearTimeout(runTimer); }
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    country,
    sources,
    seedOffset: offset,
    seedLimit: limit,
    limits: { requests: MAX_REQUESTS, responseBytes: MAX_BYTES, requestTimeoutMs: REQUEST_MS, runTimeoutMs: RUN_MS, minimumIntervalMs: MIN_INTERVAL_MS },
    requestsMade: requests,
    limitations: ['Public suggestions are wording observations, not search frequencies, ranking positions or keyword volumes.', 'Trending-feed traffic labels are provider statements for a feed item, not monthly keyword volume or verified marketplace demand.', 'Country parameters request localization; providers may ignore them. No claim of country-exclusive demand is made.', 'Starter catalogue and category definitions do not prove current publication, stock, price or demand.', 'Relevant suggestions are review candidates, never instructions to publish metadata. Personal names, competitor brands and irrelevant phrases require editorial rejection.'],
    catalogueCandidates: candidates,
    taxonomy: marketplaceCategories.map(({ key, name }) => ({ key, name })),
    observations,
    evidence: records,
  };
}

function markdownCell(value) { return String(value).replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '').replace(/([\\`\[\]])/g, '\\$1'); }

export function renderResearchMarkdown(report) {
  const lines = ['# Public keyword research review', '', `Generated: ${report.generatedAt}  `, `Requested country: ${report.country}  `, `Relevant observations: ${report.evidence.length}`, '', ...report.limitations.map((limitation) => `- ${limitation}`), '', '## Source checks', '', '| UTC time | URL | Outcome |', '| --- | --- | --- |', ...report.observations.map((item) => `| ${markdownCell(item.observedAt)} | ${markdownCell(item.url)} | ${markdownCell(`${item.status || ''} ${item.outcome}: ${item.reason || ''}`)} |`), '', '## Observed wording for editorial review', '', '| Wording | Evidence type | Source | Matched catalogue product |', '| --- | --- | --- | --- |', ...report.evidence.map((item) => `| ${markdownCell(item.term)} | ${markdownCell(item.evidenceType)} | ${markdownCell(item.sourceUrl)} | ${markdownCell(item.relevance.map(({ productTitle }) => productTitle).join('; '))} |`), '', '## Catalogue-derived candidates (unvalidated demand)', '', ...report.catalogueCandidates.map((item) => `- ${markdownCell(item.term)} — ${markdownCell(item.productTitle)}`), ''];
  return lines.join('\n');
}

async function main() {
  const options = { country: 'UG', sources: ['google'], limit: 4, offset: 0 };
  for (const argument of process.argv.slice(2)) {
    if (argument === '--help') {
      console.log('Usage: node scripts/seo-keyword-research.js [--country=UG|KE|TZ|RW|SS] [--sources=trends,google,bing] [--limit=1..4] [--offset=0..11]');
      console.log('Writes JSON and Markdown under ignored artifacts/seo/. Does not publish or change application data.');
      return;
    }
    const match = /^--(country|sources|limit|offset)=(.+)$/.exec(argument);
    if (!match) throw new Error('Unsupported argument; use --help.');
    if (match[1] === 'country') options.country = match[2].toUpperCase();
    if (match[1] === 'sources') options.sources = match[2].split(',');
    if (match[1] === 'limit') options.limit = Number(match[2]);
    if (match[1] === 'offset') options.offset = Number(match[2]);
  }
  // Respect the environment's existing proxy route and retain normal TLS verification.
  const restoreProxy = setGlobalProxyFromEnv();
  let report;
  try { report = await collectResearch(options); }
  finally { restoreProxy(); }
  const directory = path.join(ROOT, 'artifacts', 'seo');
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  const stem = `${report.generatedAt.replace(/[:.]/g, '-')}-${report.country}-${process.pid}`;
  await fs.writeFile(path.join(directory, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
  await fs.writeFile(path.join(directory, `${stem}.md`), renderResearchMarkdown(report), { flag: 'wx', mode: 0o640 });
  console.log(`[seo-research] ${report.evidence.length} relevant observations; ${report.observations.filter(({ outcome }) => outcome === 'unavailable').length} unavailable checks. Reports: artifacts/seo/${stem}.{json,md}`);
  if (!report.evidence.length && report.observations.some(({ outcome }) => outcome === 'unavailable')) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('[seo-research] Failed; check supported arguments, local write access and network policy. No application data changed.'); process.exitCode = 1; });
}
