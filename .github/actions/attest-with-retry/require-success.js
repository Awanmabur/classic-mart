import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outcomes = new Set(['', 'success', 'failure', 'skipped', 'cancelled']);
const attempts = ['FIRST', 'SECOND', 'THIRD'];
const maxBundleBytes = 32 * 1024 * 1024;
const sigstoreMediaTypes = new Set([
  'application/vnd.dev.sigstore.bundle.v0.3+json',
  'application/vnd.dev.sigstore.bundle+json;version=0.1',
  'application/vnd.dev.sigstore.bundle+json;version=0.2',
]);

function encodedBytes(value) {
  return typeof value === 'string' && value.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}

function singleLine(value, required = false) {
  if (typeof value !== 'string' || value.length > 10_000 || /[\r\n\0]/.test(value) || (required && !value.trim())) {
    throw new Error('The successful signing attempt returned invalid output.');
  }
  return value;
}

/** Only a successful official action can supply the required signed bundle. */
export function requireSuccessfulAttestation(environment = process.env) {
  if (environment.CANCELLED !== 'false') throw new Error('Signing was cancelled or its completion state is unavailable.');
  const states = attempts.map(name => environment[name + '_OUTCOME'] || '');
  if (states.some(value => !outcomes.has(value) || value === 'cancelled')) {
    throw new Error('A signing attempt did not complete normally.');
  }
  const winner = states.indexOf('success');
  if (winner < 0) throw new Error('All signing attempts failed. A successful attestation is required before releasing artifacts.');
  const prefix = attempts[winner];
  const bundlePath = singleLine(environment[prefix + '_BUNDLE'] || '', true);
  if (!path.isAbsolute(bundlePath)) throw new Error('The signing bundle must be an absolute file path.');
  let bundle;
  try {
    const stat = fs.lstatSync(bundlePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBundleBytes) throw new Error();
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch {
    throw new Error('The successful signing attempt has no readable, complete signature bundle.');
  }
  // The official action verifies Sigstore, its certificate and transparency
  // service. This check requires its actual output; it does not replace that
  // verification with a custom signer or accept a failed attempt's partial file.
  const envelope = bundle?.dsseEnvelope;
  const material = bundle?.verificationMaterial;
  const certificates = material?.x509CertificateChain?.certificates;
  const hasCertificate = encodedBytes(material?.certificate?.rawBytes) ||
    (Array.isArray(certificates) && certificates.length > 0 &&
      certificates.every(certificate => encodedBytes(certificate?.rawBytes)));
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) ||
      !sigstoreMediaTypes.has(bundle.mediaType) ||
      !material || typeof material !== 'object' || Array.isArray(material) || !hasCertificate ||
      !envelope || envelope.payloadType !== 'application/vnd.in-toto+json' || !encodedBytes(envelope.payload) ||
      !Array.isArray(envelope.signatures) || !envelope.signatures.length ||
      envelope.signatures.some(signature => !encodedBytes(signature?.sig))) {
    throw new Error('The official signing output is not a complete Sigstore DSSE bundle.');
  }
  return {
    'bundle-path': bundlePath,
    'attestation-id': singleLine(environment[prefix + '_ID'] || ''),
    'attestation-url': singleLine(environment[prefix + '_URL'] || ''),
  };
}

export function completeAttestation(environment = process.env) {
  const values = requireSuccessfulAttestation(environment);
  if (!environment.GITHUB_OUTPUT) throw new Error('The GitHub output destination is unavailable.');
  fs.appendFileSync(environment.GITHUB_OUTPUT,
    Object.entries(values).map(([name, value]) => name + '=' + value + '\n').join(''));
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    completeAttestation();
    console.log('Required release attestation completed successfully.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'A successful release attestation is required.';
    console.error('::error title=Release attestation required::' + message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
    process.exitCode = 1;
  }
}
