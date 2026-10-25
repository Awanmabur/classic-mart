import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

test('CI scans the production container and attests release provenance/SBOM',()=>{
  const ci=read('.github/workflows/ci.yml');
  assert.match(ci,/build-arg BUILD_SHA=\$\{\{ github\.sha \}\}/);
  assert.match(ci,/aquasecurity\/trivy-action@v0\.36\.0/);
  assert.match(ci,/severity: HIGH,CRITICAL/);
  assert.match(ci,/exit-code: '1'/);
  assert.match(ci,/uses: actions\/attest@v4/);
  assert.match(ci,/subject-path: 'dist\/\*\.zip'/);
  assert.match(ci,/sbom-path: artifacts\/classic-mart-sbom\.cdx\.json/);
});

test('deployment promotion requires certified exact SHA across staging canary and production',()=>{
  const deploy=read('.github/workflows/deploy.yml');
  assert.match(deploy,/actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{PROMOTE_SHA\}&status=success/);
  assert.match(deploy,/git fetch origin refs\/heads\/master:refs\/remotes\/origin\/master/);
  assert.match(deploy,/git merge-base --is-ancestor \"\$PROMOTE_SHA\" origin\/master/);
  assert.match(deploy,/\.event == \"push\" and \.head_branch == \"master\"/);
  assert.doesNotMatch(deploy,/origin\/main|head_branch == \"main\"/);
  assert.match(deploy,/environment: staging/);
  assert.match(deploy,/environment: canary/);
  assert.match(deploy,/environment: production/);
  assert.match(deploy,/needs: staging/);
  assert.match(deploy,/needs: canary/);
  assert.match(deploy,/EXPECTED_BUILD_SHA: \$\{\{ inputs\.commit_sha \}\}/);
  assert.match(deploy,/node scripts\/deploy-smoke\.js/);
});

test('runtime exposes non-secret build identity and deployment smoke fails on wrong SHA',()=>{
  const env=read('src/config/env.js');
  const health=read('src/routes/health.js');
  const smoke=read('scripts/deploy-smoke.js');
  const docker=read('Dockerfile');
  assert.match(env,/process\.env\.BUILD_SHA \|\| process\.env\.RENDER_GIT_COMMIT \|\| process\.env\.SOURCE_COMMIT/);
  assert.match(health,/\/health\/version/);
  assert.match(health,/buildSha: env\.buildSha \|\| null/);
  assert.match(smoke,/EXPECTED_BUILD_SHA/);
  assert.match(smoke,/build SHA mismatch/);
  assert.match(smoke,/\/health\/ready/);
  assert.match(docker,/^ARG BUILD_SHA=$/m);
  assert.match(docker,/ENV BUILD_SHA=\$BUILD_SHA/);
});

test('deployment policy requires protected staging canary production promotion',()=>{
  const doc=read('docs/DEPLOYMENT_PROMOTION.md');
  assert.match(doc,/staging/i);
  assert.match(doc,/canary/i);
  assert.match(doc,/production/i);
  assert.match(doc,/required reviewers/i);
  assert.match(doc,/exact reviewed commit/i);
});


test('sanitized release preserves source-control runtime exclusions required by its own canonical checks',()=>{
  const builder=read('scripts/build-release.js');
  const checker=read('scripts/check-release-scripts.js');
  const gitignore=read('.gitignore');
  assert.match(builder,/const allow=\[[^\]]*['"]\.gitignore['"]/s);
  assert.match(checker,/['"]\.gitignore['"]/);
  assert.match(gitignore,/\.classic-mart\//);
  assert.match(gitignore,/storage\/exports\//);
});


test('CI activates isolated live database fixtures with Chromium and the model lifecycle runner',()=>{
  const ci=read('.github/workflows/ci.yml');
  const runner=read('scripts/run-tests.js');
  assert.match(ci,/branches: \[master\]/);
  assert.match(ci,/CLASSIC_MART_LIVE_TEST_MONGO_URI: mongodb:\/\/127\.0\.0\.1:27018\/classic_mart_ci_test\?replicaSet=rs0/);
  assert.ok(ci.indexOf('playwright install --with-deps chromium') < ci.indexOf('run: npm test'));
  assert.match(runner,/CLASSIC_MART_LIVE_TEST_MONGO_URI[\s\S]*--test-concurrency=1[\s\S]*live-test-model-lifecycle\.js/);
});

test('Docker carries launch evidence and R2 operations without copying prototype engines or seed data',()=>{
  const docker=read('Dockerfile');
  const ignore=read('.dockerignore');
  assert.match(docker,/COPY[^\n]*scripts\/check-r2\.js[^\n]*scripts\/launch-evidence\.js/);
  for(const relative of ['dashboard-preview/','test/','tests/','src/config/initial-catalogue.js',
    'public/assets/products/','public/approved-dashboard/script.js','public/approved-dashboard/role-workspaces.js',
    'public/approved-dashboard/enhancements.js','public/approved-dashboard/session-controls.js']) assert.ok(ignore.split('\n').includes(relative),relative);
  assert.match(ignore,/^scripts\/\*$/m);
  assert.match(ignore,/^!scripts\/check-r2\.js$/m);
  assert.match(ignore,/^!scripts\/launch-evidence\.js$/m);
  assert.match(docker,/COPY[^\n]*scripts\/staff-access\.js[^\n]*scripts\/operator-input\.js/);
  assert.match(ignore,/^!scripts\/staff-access\.js$/m);
  assert.match(ignore,/^!scripts\/operator-input\.js$/m);
});
