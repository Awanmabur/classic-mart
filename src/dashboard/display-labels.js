const REFERENCE_NAMES = Object.freeze({
  usr: 'Account', ord: 'Order', pay: 'Payment', ref: 'Referral', rfd: 'Refund',
  ret: 'Return', dsp: 'Dispute', tkt: 'Ticket',
  str: 'Store', prd: 'Product', var: 'Product option', cat: 'Category',
  pgr: 'Staff assignment', apr: 'Review request',
  shp: 'Shipment', sshp: 'Seller shipment', pyo: 'Payout',
  ntf: 'Notification', cmp: 'Campaign',
  adr: 'Address', binv: 'Company invitation', biz: 'Company',
  bmem: 'Company member', bpo: 'Purchase order', bpr: 'Procurement request',
  bprun: 'Procurement run', bpt: 'Procurement template', bqr: 'Quote request',
  brd: 'Record', case: 'Trust case', cms: 'Content', com: 'Commission',
  conv: 'Conversation', cpn: 'Coupon', dex: 'Delivery exception', dlp: 'Delivery partner',
  dof: 'Delivery offer', evd: 'Evidence', fdg: 'Finance summary',
  gft: 'Gift card', inc: 'Incident', kyc: 'Verification', lac: 'Ledger account',
  lot: 'Inventory lot', ltx: 'Ledger transaction', mac: 'Reply macro',
  med: 'Media', mov: 'Inventory movement', mqa: 'Quality review',
  opa: 'Recorded action', par: 'Parcel', plk: 'Affiliate link',
  poa: 'Payout account', prv: 'Request', rec: 'Reconciliation',
  rev: 'Review', rinvite: 'Referral invitation', rsk: 'Risk review',
  rsv: 'Stock reservation', rwd: 'Reward', sch: 'Billing attempt',
  sen: 'Subscription enrollment', sinv: 'Staff invitation', sord: 'Seller order',
  spl: 'Subscription plan', spr: 'Record', sti: 'Store invitation',
  subpay: 'Subscription payment', trc: 'Trust case', whd: 'Webhook delivery',
  wtk: 'Warehouse task',
  aev: 'AI evaluation', aid: 'Shopping draft', aie: 'Search index entry',
  aif: 'AI feedback', aij: 'Assistance task', aiu: 'Assistance usage',
  alt: 'Product alert', api: 'Integration', avt: 'Profile photo',
  bbud: 'Company budget', bdoc: 'Company document', blk: 'Security block',
  browse: 'Browsing session', cap: 'Campaign application', cbk: 'Chargeback',
  chk: 'Checkout', contact: 'Seller conversation', crt: 'Cart',
  dev: 'Signed-in device', doc: 'Verification document', evt: 'Event',
  exp: 'Data export', fam: 'Mobile session family', fdoc: 'Financial document',
  flg: 'Feature setting', fnd: 'Security finding', idc: 'Inventory discrepancy',
  idem: 'Request key', kb: 'Help article', loe: 'Points entry',
  loy: 'Points account', mfr: 'Authenticator recovery', mkt: 'Marketing campaign',
  mob: 'Mobile session', msg: 'Message', nws: 'Newsletter subscription',
  oli: 'Order item', ops: 'Operational alert', pbrand: 'Brand follow',
  pcontact: 'Promoter conversation', psch: 'Scheduled price', psh: 'Push device',
  que: 'Product question', req: 'Request', rpr: 'Return resolution',
  run: 'Operation run', sat: 'Satisfaction survey', scr: 'Plan change request',
  sdg: 'Support summary', sea: 'Saved search', sec: 'Security event',
  src: 'Seller return', stk: 'Stock record', stm: 'Store member',
  tc: 'Trust case', tch: 'Attribution record', wav: 'Picking wave',
  whk: 'Webhook', whs: 'Warehouse', wtu: 'Wallet top-up',
  zon: 'Shipping zone',
});

// Current generators use UUID hex; earlier stored records may use other
// 32-character hex suffixes. Only complete, known-prefix references qualify;
// ordinary text and strings containing embedded IDs are never rewritten.
const GENERATED_REFERENCE = /^([a-z][a-z0-9]*)_([a-f0-9]{32})$/i;
const SHARED_PREFIXES = new Set(['brd', 'prv', 'spr']);

function knownName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  const reference = GENERATED_REFERENCE.exec(name);
  return name && !(reference && Object.hasOwn(REFERENCE_NAMES, reference[1].toLowerCase())) ? name : '';
}

/** Format visible labels only. Original record IDs remain intact in routes,
 * forms, scoped DTOs and exports; no additional identity lookup is performed. */
export function displayDashboardReference(value, { column = '', columns = [], row, user } = {}) {
  if (value == null || value === '') return '—';
  if (typeof value !== 'string') return value;
  const match = GENERATED_REFERENCE.exec(value);
  const personReference = match?.[1].toLowerCase() === 'usr'
    || (/^[a-f0-9]{24}$/i.test(value) && /^(account|user|actor|member|customer|beneficiary|owner)$/i.test(column));
  if (personReference) {
    if (user?.publicId === value && knownName(user.name)) return knownName(user.name);
    // An account table already supplies the name authorized by that table's
    // source projection. Do not reuse an unrelated row's title or actor name.
    if (/^(account|user|member|customer)$/i.test(column)) {
      const nameIndex = columns.findIndex(name => /^name$/i.test(name));
      const name = nameIndex >= 0 ? knownName(row?.cells?.[nameIndex]) : '';
      if (name) return name;
    }
    return 'Account holder';
  }
  if (!match) return value;
  const prefix = match[1].toLowerCase(), reference = match[2].slice(-8).toUpperCase();
  // Historical models share these prefixes. The authorized table column
  // identifies the source; the prefix alone must not invent an entity type.
  const name = SHARED_PREFIXES.has(prefix) && /^[a-z][a-z /&-]{1,50}$/i.test(column)
    && !/^(?:reference|record|value|target|name|title)$/i.test(column) ? column : REFERENCE_NAMES[prefix];
  return name ? `${name} · ${reference}` : value;
}

export function dashboardRecordHeading(record) {
  if (!record) return 'Record details';
  for (const key of ['name', 'title', 'companyName', 'subject']) {
    if (knownName(record[key])) return knownName(record[key]);
  }
  return displayDashboardReference(record.publicId || record.code || record.key || record.workerId || 'Record details');
}
