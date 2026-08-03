export function normalizeProjectPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

export function isSecurityChecker(value) {
  return normalizeProjectPath(value) === 'scripts/security-check.js';
}
