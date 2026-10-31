import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { completeAttestation, requireSuccessfulAttestation } from '../.github/actions/attest-with-retry/require-success.js';

const scriptPath = fileURLToPath(new URL('../.github/actions/attest-with-retry/require-success.js', import.meta.url));
const attemptNames = ['FIRST', 'SECOND', 'THIRD'];

test('composite environment expressions use only runner-supported functions', () => {
  // actions/runner action_yaml.json allows status functions in step-if, but
  // step-env permits only hashFiles. Generic YAML parsing cannot catch this.
  const action = fs.readFileSync(new URL('../.github/actions/attest-with-retry/action.yml', import.meta.url), 'utf8');
  const environment = action.match(/^      env:\n((?: {8}.+\n)+)/m)?.[1];
  assert.ok(environment, 'The required signing guard environment must be inspected.');
  for (const [, expression] of environment.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const [, name] of expression.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      assert.equal(name, 'hashFiles', `Unsupported function in composite step-env: ${name}`);
    }
  }
  assert.match(environment, /CANCELLED: \$\{\{ job\.status == 'cancelled' \}\}/);
  assert.match(action, /if: \$\{\{ always\(\) \}\}/);
});

function signedBundle() {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: Buffer.from('certificate supplied by the successful official action').toString('base64') },
    },
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', subject: [] })).toString('base64'),
      signatures: [{ sig: Buffer.from('signature supplied by the successful official action').toString('base64') }],
    },
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attestation-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundlePath = path.join(directory, 'bundle.json');
  const outputPath = path.join(directory, 'github-output');
  fs.writeFileSync(bundlePath, JSON.stringify(signedBundle()));
  fs.writeFileSync(outputPath, 'existing=value\n');
  const environment = { CANCELLED: 'false', GITHUB_OUTPUT: outputPath };
  for (const name of attemptNames) {
    for (const suffix of ['OUTCOME', 'BUNDLE', 'ID', 'URL']) environment[`${name}_${suffix}`] = '';
  }
  return { directory, bundlePath, outputPath, environment };
}

function successEnvironment(f, attempt = 0) {
  const environment = { ...f.environment };
  for (let index = 0; index < attempt; index++) environment[`${attemptNames[index]}_OUTCOME`] = 'failure';
  environment[`${attemptNames[attempt]}_OUTCOME`] = 'success';
  environment[`${attemptNames[attempt]}_BUNDLE`] = f.bundlePath;
  return environment;
}

function runCli(environment) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 10_000,
  });
}

function assertCliFailure(f, environment, message) {
  const result = runCli(environment);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /::error title=Release attestation required::/);
  if (message) assert.match(result.stderr, message);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'existing=value\n');
}

for (const [index, name] of attemptNames.entries()) {
  test(`CLI publishes only the ${name.toLowerCase()} successful official attempt's bundle and metadata`, t => {
    const f = fixture(t);
    const environment = successEnvironment(f, index);
    for (const previous of attemptNames.slice(0, index)) {
      environment[`${previous}_BUNDLE`] = path.join(f.directory, 'failed-partial.json');
      environment[`${previous}_ID`] = 'failed-id';
      environment[`${previous}_URL`] = 'https://example.test/failed';
    }
    environment[`${name}_ID`] = '12345';
    environment[`${name}_URL`] = 'https://github.com/example/repository/attestations/12345';
    const result = runCli(environment);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Required release attestation completed successfully\./);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'),
      `existing=value\nbundle-path=${f.bundlePath}\nattestation-id=12345\nattestation-url=https://github.com/example/repository/attestations/12345\n`);
  });
}

test('successful official signing needs a complete bundle but may omit its ID and URL', t => {
  const f = fixture(t);
  const environment = successEnvironment(f);
  delete environment.FIRST_ID;
  delete environment.FIRST_URL;
  const expected = { 'bundle-path': f.bundlePath, 'attestation-id': '', 'attestation-url': '' };
  assert.deepEqual(requireSuccessfulAttestation(environment), expected);
  assert.deepEqual(completeAttestation(environment), expected);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), `existing=value\nbundle-path=${f.bundlePath}\nattestation-id=\nattestation-url=\n`);
});

for (const version of ['0.1', '0.2']) {
  test(`CLI accepts the supported legacy Sigstore ${version} bundle and certificate chain`, t => {
    const f = fixture(t);
    const bundle = signedBundle();
    bundle.mediaType = `application/vnd.dev.sigstore.bundle+json;version=${version}`;
    bundle.verificationMaterial = {
      x509CertificateChain: { certificates: [bundle.verificationMaterial.certificate] },
    };
    fs.writeFileSync(f.bundlePath, JSON.stringify(bundle));
    const result = runCli(successEnvironment(f));
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'),
      `existing=value\nbundle-path=${f.bundlePath}\nattestation-id=\nattestation-url=\n`);
  });
}

test('failed official attempts cannot release artifacts even when they leave a complete-looking bundle', t => {
  const f = fixture(t);
  const environment = { ...f.environment };
  for (const name of attemptNames) {
    environment[`${name}_OUTCOME`] = 'failure';
    environment[`${name}_BUNDLE`] = f.bundlePath;
  }
  assertCliFailure(f, environment, /All signing attempts failed/);
});

test('a partial bundle from a failed attempt cannot replace the successful attempt output', t => {
  const f = fixture(t);
  const environment = successEnvironment(f, 1);
  environment.FIRST_BUNDLE = f.bundlePath;
  environment.SECOND_BUNDLE = '';
  assertCliFailure(f, environment, /invalid output/);
});

test('no completed successful attempt is rejected', t => {
  const f = fixture(t);
  assertCliFailure(f, f.environment, /All signing attempts failed/);
});

for (const cancelled of ['true', '', undefined]) {
  test(`cancellation state ${String(cancelled)} prevents output even after a successful attempt`, t => {
    const f = fixture(t);
    const environment = { ...successEnvironment(f), CANCELLED: cancelled };
    if (cancelled === undefined) delete environment.CANCELLED;
    // Avoid inherited environment variables hiding the missing-state case.
    if (cancelled === undefined) {
      assert.throws(() => completeAttestation(environment), /cancelled|completion state/);
      assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'existing=value\n');
    } else {
      assertCliFailure(f, environment, /cancelled|completion state/);
    }
  });
}

for (const outcome of ['cancelled', 'unexpected']) {
  test(`${outcome} attempt state prevents publishing an earlier success`, t => {
    const f = fixture(t);
    assertCliFailure(f, { ...successEnvironment(f), SECOND_OUTCOME: outcome }, /did not complete normally/);
  });
}

test('unreadable, empty, truncated, and relative bundle outputs all fail without publishing', t => {
  const f = fixture(t);
  const environment = successEnvironment(f);
  for (const [label, contents] of [['empty', ''], ['truncated', '{"mediaType":'], ['invalid-json', 'not JSON']]) {
    const filename = path.join(f.directory, `${label}.json`);
    fs.writeFileSync(filename, contents);
    assertCliFailure(f, { ...environment, FIRST_BUNDLE: filename }, /complete signature bundle/);
  }
  assertCliFailure(f, { ...environment, FIRST_BUNDLE: path.join(f.directory, 'missing.json') }, /complete signature bundle/);
  assertCliFailure(f, { ...environment, FIRST_BUNDLE: f.directory }, /complete signature bundle/);
  assertCliFailure(f, { ...environment, FIRST_BUNDLE: 'bundle.json' }, /absolute file path/);
});

test('symlink and oversized bundle outputs fail before their content can be accepted', t => {
  const f = fixture(t);
  const symlink = path.join(f.directory, 'bundle-link.json');
  fs.symlinkSync(f.bundlePath, symlink);
  assertCliFailure(f, { ...successEnvironment(f), FIRST_BUNDLE: symlink }, /complete signature bundle/);
  const oversized = path.join(f.directory, 'oversized.json');
  fs.writeFileSync(oversized, JSON.stringify(signedBundle()));
  fs.truncateSync(oversized, 32 * 1024 * 1024 + 1);
  assertCliFailure(f, { ...successEnvironment(f), FIRST_BUNDLE: oversized }, /complete signature bundle/);
});

test('a successful outcome cannot make incomplete or unrelated JSON into a DSSE bundle', t => {
  const f = fixture(t);
  const withEnvelope = changes => {
    const bundle = signedBundle();
    bundle.dsseEnvelope = { ...bundle.dsseEnvelope, ...changes };
    return bundle;
  };
  const invalidBundles = [
    null, [], {},
    { ...signedBundle(), mediaType: 'application/json' },
    { ...signedBundle(), mediaType: 'application/vnd.dev.sigstore.bundle.v99.0+json' },
    { ...signedBundle(), mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.9' },
    { ...signedBundle(), verificationMaterial: null },
    { ...signedBundle(), verificationMaterial: [] },
    { ...signedBundle(), verificationMaterial: {} },
    { ...signedBundle(), verificationMaterial: { certificate: {} } },
    { ...signedBundle(), verificationMaterial: { certificate: { rawBytes: '' } } },
    { ...signedBundle(), verificationMaterial: { certificate: { rawBytes: 'invalid base64!' } } },
    { ...signedBundle(), verificationMaterial: { certificate: { rawBytes: 'YR==' } } },
    { ...signedBundle(), verificationMaterial: { x509CertificateChain: { certificates: [] } } },
    { ...signedBundle(), dsseEnvelope: undefined },
    withEnvelope({ payloadType: undefined }),
    withEnvelope({ payloadType: 'application/json' }),
    withEnvelope({ payload: '' }),
    withEnvelope({ payload: 'invalid base64!' }),
    withEnvelope({ payload: 'YQ' }),
    withEnvelope({ payload: 'YWJj\n' }),
    withEnvelope({ payload: 'YR==' }),
    withEnvelope({ signatures: [] }),
    withEnvelope({ signatures: [{}] }),
    withEnvelope({ signatures: [{ sig: '' }] }),
    withEnvelope({ signatures: [{ sig: 'invalid base64!' }] }),
    withEnvelope({ signatures: [{ sig: 'YR==' }] }),
    withEnvelope({ signatures: [{ sig: 'c2lnbmF0dXJl' }, null] }),
  ];
  for (const bundle of invalidBundles) {
    fs.writeFileSync(f.bundlePath, JSON.stringify(bundle));
    assertCliFailure(f, successEnvironment(f), /complete Sigstore DSSE bundle/);
  }
});

test('bundle paths and optional metadata cannot inject additional GitHub output lines', t => {
  const f = fixture(t);
  for (const field of ['FIRST_BUNDLE', 'FIRST_ID', 'FIRST_URL']) {
    for (const injection of ['\nforged=value', '\rforged=value', '\0forged=value']) {
      const environment = { ...successEnvironment(f), [field]: f.bundlePath + injection };
      // NUL cannot be passed through an operating-system environment.
      if (injection.startsWith('\0')) {
        assert.throws(() => completeAttestation(environment), /invalid output/);
        assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'existing=value\n');
      } else {
        assertCliFailure(f, environment, /invalid output/);
      }
    }
  }
});

test('a successful bundle still requires an available GitHub output destination', t => {
  const f = fixture(t);
  assertCliFailure(f, { ...successEnvironment(f), GITHUB_OUTPUT: '' }, /output destination is unavailable/);
});
