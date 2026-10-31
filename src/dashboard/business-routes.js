export const BUSINESS_LIVE_ROUTES=Object.freeze({
  'business-overview':'/business/overview','business-orders':'/business/orders','business-quotes':'/business/quotes',
  'business-invoices':'/business/invoices','business-templates':'/business/templates','business-settings':'/business/settings',
});
export const BUSINESS_PAGES=Object.freeze([
  ['business-overview','Overview','i-grid','Business','Business Overview','Track company purchasing, approvals, deliveries and spend.','overview'],
  ['business-orders','Business Orders','i-clipboard','Procurement','Business Orders','Manage independently approved purchases and supplier fulfilment.','orders'],
  ['business-quotes','Quotations','i-bag','Procurement','Supplier Quotations','Review exact supplier offers before issuing a purchase order.','quotes'],
  ['business-invoices','Invoices','i-card','Finance','Business Invoices','Pay company invoices and download private commercial documents.','invoices'],
  ['business-templates','Templates','i-refresh','Procurement','Procurement Templates','Create reusable purchasing lists with independent approval on every run.','templates'],
  ['business-settings','Business Settings','i-user','Configuration','Business Settings','Manage company contacts, members, budgets and credit requests.','settings'],
]);
export const BUSINESS_LEGACY_ROUTES=Object.freeze({...BUSINESS_LIVE_ROUTES,'business-suppliers':'/business/quotes','business-payments':'/business/invoices','business-reports':'/business/invoices'});
export const businessNavigation=()=>BUSINESS_PAGES.map(([id,label,icon,group])=>({id,label,icon,group,href:BUSINESS_LIVE_ROUTES[id],ready:true}));
