import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const components=[];
for(const [location,pkg] of Object.entries(lock.packages||{})){
  if(!location||!pkg?.version)continue;
  const inferred=location.split('node_modules/').at(-1);
  const name=pkg.name||inferred;
  if(!name)continue;
  const purlName=name.startsWith('@')?`${encodeURIComponent(name.split('/')[0])}/${encodeURIComponent(name.split('/').slice(1).join('/'))}`:encodeURIComponent(name);
  components.push({
    type:'library',
    name,
    version:pkg.version,
    purl:`pkg:npm/${purlName}@${pkg.version}`,
    scope:pkg.dev?'optional':undefined,
    properties:[{name:'classic-mart:lockPath',value:location}],
  });
}
components.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
const bom={
  bomFormat:'CycloneDX',
  specVersion:'1.6',
  serialNumber:`urn:uuid:${crypto.randomUUID()}`,
  version:1,
  metadata:{timestamp:new Date().toISOString(),component:{type:'application',name:lock.name||'classic-mart',version:lock.version||'0.0.0'}},
  components,
};
fs.mkdirSync('artifacts',{recursive:true});
const target=path.join('artifacts','classic-mart-sbom.cdx.json');
fs.writeFileSync(target,JSON.stringify(bom,null,2)+'\n');
console.log(`${target} (${components.length} locked components)`);
