import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertCiMongoKernel } from '../scripts/check-ci-mongo-kernel.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const cli=fileURLToPath(new URL('../scripts/check-ci-mongo-kernel.js',import.meta.url));

test('the pinned MongoDB accepts supported Linux kernels including Azure suffixes and the final pre-6.19 boundary',()=>{
  for(const release of ['4.18.0-553.el8.x86_64','5.15.0-119-generic','6.8.0-1041-azure','6.17.0-1022-azure','6.18.55','6.18.0-rc7+']){
    assert.deepEqual(assertCiMongoKernel({platform:'linux',release}),{
      platform:'linux',kernel:release,mongoVersion:'8.0.32',
    });
  }
});

test('the known kernel incompatibility includes 6.19 candidates, later minors and later major versions',()=>{
  for(const release of ['6.19.0','6.19.0-rc1','6.19.12-azure','6.20.0','7.0.0','10.2.3']){
    assert.throws(()=>assertCiMongoKernel({platform:'linux',release}),/6\.19|incompatib|unsupported/i,release);
  }
});

test('a Linux runner is required and malformed or unbounded versions cannot pass the compatibility gate',()=>{
  for(const platform of ['darwin','win32','freebsd','',null]){
    assert.throws(()=>assertCiMongoKernel({platform,release:'6.8.0-azure'}));
  }
  for(const release of ['',null,17,false,{},'6','v6.18.0','6.x.0','6.18..0',' 6.18.0','6.18.0 ',
    '6.18.0\n::warning::forged','6.18.0\r','6.18.0\u0000','6.18.0\u001b[31m','6.18.0\u007f',
    '9007199254740992.0.0','6.9007199254740992.0','6.18.9007199254740992']){
    assert.throws(()=>assertCiMongoKernel({platform:'linux',release}));
  }
  const prefix='6.18.0-';
  assert.equal(assertCiMongoKernel({platform:'linux',release:prefix+'x'.repeat(128-prefix.length)}).kernel.length,128);
  assert.throws(()=>assertCiMongoKernel({platform:'linux',release:prefix+'x'.repeat(129-prefix.length)}));
});

function runCli(args=[]){
  const environment={...process.env};
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath,[...args,cli],{
    cwd:root,env:environment,encoding:'utf8',timeout:10_000,maxBuffer:32_000,shell:false,
  });
}

test('the actual CLI inspects its host kernel and preserves a real pass or failure exit status',()=>{
  let compatible;
  try{compatible=assertCiMongoKernel();}catch{compatible=null;}
  const result=runCli();
  assert.equal(result.error,undefined);
  assert.equal(result.status,compatible?0:1,result.stdout+result.stderr);
  if(compatible){
    assert.ok(result.stdout.includes(os.release()));
    assert.ok(result.stdout.includes('8.0.32'));
  }else{
    assert.equal((result.stdout+result.stderr).split('\n').filter(line=>line.startsWith('::error ')).length,1);
  }
});

test('the real CLI rejects a changed kernel before Docker and cannot emit forged workflow annotations',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'classicmart-ci-kernel-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  async function mockKernel(release){
    const filename=path.join(directory,'host-kernel.mjs');
    // Replace only Node's OS boundary in this owned subprocess. Production
    // code exposes no environment variable or CLI flag that can spoof a host.
    await fs.writeFile(filename,"import os from 'node:os';\nimport {syncBuiltinESMExports} from 'node:module';\nos.platform=()=> 'linux';\nos.release=()=> "+JSON.stringify(release)+";\nsyncBuiltinESMExports();\n");
    return runCli(['--import',pathToFileURL(filename).href]);
  }
  const supported=await mockKernel('6.18.55');
  assert.equal(supported.error,undefined);
  assert.equal(supported.status,0,supported.stdout+supported.stderr);
  assert.ok(supported.stdout.includes('6.18.55'));
  const unsupported=await mockKernel('6.19.0-1022-azure');
  assert.equal(unsupported.error,undefined);
  assert.equal(unsupported.status,1,unsupported.stdout+unsupported.stderr);
  assert.equal((unsupported.stdout+unsupported.stderr).split('\n').filter(line=>line.startsWith('::error ')).length,1);
  const malicious=await mockKernel('6.19.0\n::warning::FORGED\u001b[31m');
  assert.equal(malicious.error,undefined);
  assert.equal(malicious.status,1,malicious.stdout+malicious.stderr);
  const output=malicious.stdout+malicious.stderr;
  assert.equal(output.split('\n').filter(line=>line.startsWith('::error ')).length,1);
  assert.ok(!output.includes('\n::warning::FORGED'));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(output));
});
