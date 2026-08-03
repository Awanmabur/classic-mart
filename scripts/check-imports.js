import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scanRoots=['src','scripts','test'];
const files=[];
function walk(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const full=path.join(directory,entry.name);
    if(entry.isDirectory())walk(full);
    else if(entry.isFile()&&entry.name.endsWith('.js'))files.push(full);
  }
}
for(const rel of scanRoots){const full=path.join(root,rel);if(fs.existsSync(full))walk(full);}

const exportCache=new Map();
function exportedNames(file){
  if(exportCache.has(file))return exportCache.get(file);
  const source=fs.readFileSync(file,'utf8');
  const names=new Set();
  for(const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g))names.add(match[1]);
  for(const match of source.matchAll(/\bexport\s*\{([^}]+)\}/gs)){
    for(const raw of match[1].split(',')){
      const item=raw.trim();if(!item)continue;
      names.add(item.split(/\s+as\s+/i).at(-1).trim());
    }
  }
  if(/\bexport\s+default\b/.test(source))names.add('default');
  exportCache.set(file,names);return names;
}

function resolveLocal(fromFile,specifier){
  if(!specifier.startsWith('.'))return null;
  let target=path.resolve(path.dirname(fromFile),specifier);
  if(!path.extname(target))target+='.js';
  return target;
}

const failures=[];
for(const file of files){
  const source=fs.readFileSync(file,'utf8');
  for(const match of source.matchAll(/\bimport\s+([^;\n]+?)\s+from\s+['"]([^'"]+)['"]/g)){
    const clause=match[1].trim();const specifier=match[2];const target=resolveLocal(file,specifier);if(!target)continue;
    if(!fs.existsSync(target)){failures.push(`${path.relative(root,file)} imports missing ${specifier}`);continue;}
    const namedBlock=clause.match(/\{([^}]+)\}/s);if(!namedBlock)continue;
    const available=exportedNames(target);
    for(const raw of namedBlock[1].split(',')){
      const imported=raw.trim().split(/\s+as\s+/i)[0]?.trim();
      if(imported&&!available.has(imported))failures.push(`${path.relative(root,file)} imports ${imported} from ${path.relative(root,target)}, but that name is not exported`);
    }
  }
  for(const match of source.matchAll(/\bexport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)){
    const specifier=match[2];const target=resolveLocal(file,specifier);if(!target)continue;
    if(!fs.existsSync(target)){failures.push(`${path.relative(root,file)} re-exports from missing ${specifier}`);continue;}
    const available=exportedNames(target);
    for(const raw of match[1].split(',')){
      const sourceName=raw.trim().split(/\s+as\s+/i)[0]?.trim();
      if(sourceName&&!available.has(sourceName))failures.push(`${path.relative(root,file)} re-exports ${sourceName} from ${path.relative(root,target)}, but that name is not exported`);
    }
  }
}

if(failures.length){console.error(`Import/export integrity gate failed:\n- ${failures.join('\n- ')}`);process.exit(1);}
console.log(`Import/export integrity gate passed (${files.length} JavaScript files checked).`);
