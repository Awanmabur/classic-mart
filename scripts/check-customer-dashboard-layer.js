import { checkApprovedDashboardLayer } from './check-approved-dashboard-layer.js';
export function checkCustomerDashboardLayer() { return checkApprovedDashboardLayer(); }
if(process.argv[1]?.endsWith('/check-customer-dashboard-layer.js')) {
  const failures=checkCustomerDashboardLayer();
  if(failures.length){console.error(failures.join('\n'));process.exit(1);}
  console.log('Customer dashboard uses the approved UI only.');
}
