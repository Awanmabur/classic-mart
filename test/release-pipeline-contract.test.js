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
  assert.match(deploy,/git merge-base --is-ancestor \"\$PROMOTE_SHA\" origin\/main/);
  assert.match(deploy,/\.event == \"push\" and \.head_branch == \"main\"/);
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
  assert.match(docker,/ARG BUILD_SHA=unknown/);
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
