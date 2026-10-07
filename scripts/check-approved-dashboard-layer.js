import fs from 'node:fs';
export function checkApprovedDashboardLayer() {
  const required=['views/approved-dashboard.ejs','views/partials/customer-live-pages.ejs','public/approved-dashboard/styles.css','public/approved-dashboard/role-workspaces.css','public/approved-dashboard/design-system.css','public/approved-dashboard/customer-live.js'];
  const retired=['public/dashboard','public/dashboard-v19','public/account.css','src/middleware/unified-dashboard.js'];
  const failures=[...required.filter(p=>!fs.existsSync(p)).map(p=>`Missing approved UI: ${p}`),...retired.filter(p=>fs.existsSync(p)).map(p=>`Retired UI returned: ${p}`)];
  return failures;
}
export const approvedDashboardLayerFailures = checkApprovedDashboardLayer;
if (process.argv[1]?.endsWith('/check-approved-dashboard-layer.js')) {
  const failures=checkApprovedDashboardLayer();
  if(failures.length){console.error(failures.join('\n'));process.exit(1);}
  console.log('Approved dashboard is the sole dashboard UI.');
}
