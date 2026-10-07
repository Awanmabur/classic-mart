import fs from 'node:fs';
import path from 'node:path';

export function customerDashboardLayerFailures(root=process.cwd()){
  const failures=[];
  const exists=(rel)=>fs.existsSync(path.join(root,rel));
  const read=(rel)=>fs.readFileSync(path.join(root,rel),'utf8');
  const required=['src/dashboard/customer-registry.js','src/dashboard/customer-data.js','src/routes/dashboard.js','views/customer-dashboard.ejs','views/partials/dashboard-customer.ejs','public/dashboard/customer.js','public/dashboard/styles.css','public/dashboard/design-system.css','public/dashboard/role-workspaces.css'];
  for(const rel of required)if(!exists(rel))failures.push(`Required Customer dashboard file missing: ${rel}`);
  const forbiddenViews=['seller-dashboard.ejs','promoter-dashboard.ejs','business-dashboard.ejs','finance-dashboard.ejs','support-dashboard.ejs','warehouse-dashboard.ejs','moderator-dashboard.ejs','country-admin-dashboard.ejs','super-admin-dashboard.ejs','platform-dashboard.ejs'];
  for(const name of forbiddenViews)if(exists(`views/${name}`))failures.push(`Later-role dashboard must not ship yet: views/${name}`);
  const forbiddenRoutes=['admin.js','business.js','logistics.js','moderation.js','seller.js','seller-growth.js'];
  for(const name of forbiddenRoutes)if(exists(`src/routes/${name}`))failures.push(`Later-role browser dashboard route must not ship yet: src/routes/${name}`);
  if(exists('src/dashboard'))for(const name of fs.readdirSync(path.join(root,'src/dashboard')))if(!['customer-registry.js','customer-data.js'].includes(name))failures.push(`Unexpected dashboard backend file in Customer checkpoint: src/dashboard/${name}`);
  if(exists('public/dashboard'))for(const name of fs.readdirSync(path.join(root,'public/dashboard'))){const full=path.join(root,'public/dashboard',name);if(fs.statSync(full).isFile()&&name.endsWith('.js')&&name!=='customer.js')failures.push(`Unexpected dashboard runtime in Customer checkpoint: public/dashboard/${name}`);}
  if(exists('views/partials'))for(const name of fs.readdirSync(path.join(root,'views/partials')))if(/^dashboard-.*\.ejs$/.test(name)&&name!=='dashboard-customer.ejs')failures.push(`Unexpected dashboard partial in Customer checkpoint: views/partials/${name}`);
  if(exists('public/dashboard/customer.js')&&/localStorage|sessionStorage|workspace-selector|role-switch|Awan Mabur|Amina Stores/i.test(read('public/dashboard/customer.js')))failures.push('Customer dashboard runtime contains demo identity/state or role switching.');
  const registry=exists('src/dashboard/customer-registry.js')?read('src/dashboard/customer-registry.js'):'';
  const pages=['dashboard','orders','wishlist','addresses','rewards','wallet','returns','support','profile','categories','cart','notifications','club'];
  for(const id of pages)if(!new RegExp(`['"]${id}['"]`).test(registry))failures.push(`Customer registry missing page ${id}.`);
  if(/seller|promoter|finance|warehouse|moderator|country_admin|super_admin/i.test(registry))failures.push('Customer registry contains a later-role workspace.');
  return failures;
}
