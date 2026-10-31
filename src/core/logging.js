const REDACTED = '[REDACTED]';
const PRIVATE_FIELD = /password|passcode|token|secret|credential|authorization|cookie|api.?key|encryption.?key|^code$|^otp$|^pin$|^headers$|^body$|^query$|^params$|^session$|^user$|^customer$|^email$|^phone$|^address$|^(?:first|last|full)?name$|^(?:original)?url$|^path$/i;

// A router's declared template is application code. URLs, baseUrl and params
// contain request data, including reset tokens and personal identifiers.
export function safeRequest(request) {
  const declaredRoute = request?.route?.path;
  const route = typeof declaredRoute === 'string' && declaredRoute.startsWith('/')
    ? declaredRoute.slice(0, 500)
    : '[unmatched]';
  const method = /^[A-Z]{1,16}$/.test(request?.method || '') ? request.method : 'UNKNOWN';
  const id = /^[a-zA-Z0-9_-]{8,80}$/.test(request?.id || '') ? request.id : undefined;
  return { id, method, route };
}

export function safeResponse(response) {
  return { statusCode: Number(response?.statusCode) || undefined };
}

export function securityEventPath(request) {
  const { route } = safeRequest(request);
  return route === '[unmatched]' ? route : `route:${route}`;
}

// Legacy security events may contain raw paths. Verify their original HMAC
// before export, then withhold that path instead of exporting old reset tokens.
export function safeSecurityEventPath(value) {
  return typeof value === 'string' && /^route:\/[^\r\n?#]*$/.test(value)
    ? value.slice(0, 500)
    : '[unmatched]';
}

function diagnosticText(value) {
  return String(value || '').slice(0, 2_000)
    .replace(/\b(?:mongodb(?:\+srv)?|https?|redis(?:s)?):\/\/[^\s)]+/gi, '[URL REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, REDACTED)
    .replace(/\b(password|token|secret|credential|authorization|cookie|api.?key|code)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export function safeError(error, { production = true, depth = 0 } = {}) {
  if (!(error instanceof Error)) {
    return production ? { type: 'NonErrorRejection' } : { type: 'NonErrorRejection', message: diagnosticText(error) };
  }
  const type = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(error.name) ? error.name : 'Error';
  const code = typeof error.code === 'number' || /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : undefined;
  const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
  // Error messages and enumerable properties often contain MongoDB input,
  // provider payloads or credentials. Production keeps useful source frames,
  // class and code without copying those values or the stack's message line.
  const stack = typeof error.stack === 'string'
    ? error.stack.split('\n').filter((line) => /^\s+at .+:\d+:\d+\)?$/.test(line))
      .slice(0, 20).map(diagnosticText).join('\n') || undefined
    : undefined;
  return {
    type, code, status,
    ...(!production ? { message: diagnosticText(error.message) } : {}),
    stack,
    ...(error.cause && depth < 2 ? { cause: safeError(error.cause, { production, depth: depth + 1 }) } : {}),
  };
}

export function safeLogFields(value, { production = true, depth = 0, seen = new WeakSet() } = {}) {
  if (value instanceof Error) return safeError(value, { production });
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (Buffer.isBuffer(value)) return '[BINARY REDACTED]';
  if (!value || typeof value !== 'object') return value;
  if (depth >= 8 || seen.has(value)) return '[TRUNCATED]';
  seen.add(value);
  const options = { production, depth: depth + 1, seen };
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeLogFields(item, options));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'err' || key === 'error') result[key] = safeError(item, { production });
    else if (key === 'req' || key === 'request') result[key] = safeRequest(item);
    else if (key === 'res' || key === 'response') result[key] = safeResponse(item);
    else if (PRIVATE_FIELD.test(key)) result[key] = REDACTED;
    else result[key] = safeLogFields(item, options);
  }
  return result;
}

// Maintenance returns counters as well as scan metadata. Preserve partial
// failures without emitting an idle success line every minute or raw results.
export function maintenanceFailures(result) {
  const counters = {};
  function collect(value, prefix = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const [key, item] of Object.entries(value)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
      const label = prefix ? `${prefix}.${key}` : key;
      if (typeof item === 'number' && Number.isFinite(item) && item > 0 && /^(?:failed|dead|critical|high|exhausted)$/.test(key)) counters[label] = item;
      else if (item && typeof item === 'object' && !Array.isArray(item)) collect(item, label, depth + 1);
    }
  }
  collect(result);
  return counters;
}
