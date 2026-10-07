(() => {
  'use strict';

  const roleProfiles = {
    customer: { label: 'Customer', name: 'Awan Mabur', shortName: 'Awan', defaultPage: 'dashboard', search: 'Search products, brands and orders...', quickLabel: 'Categories', quickPage: 'categories' },
    seller: { label: 'Seller', name: 'Amina Stores', shortName: 'Amina', defaultPage: 'seller-overview', search: 'Search products, orders and customers...', quickLabel: 'Add Product', quickPage: 'seller-add-product' },
    promoter: { label: 'Promoter', name: 'Daniel Okello', shortName: 'Daniel', defaultPage: 'promoter-overview', search: 'Search campaigns, links and conversions...', quickLabel: 'Create Link', quickPage: 'promoter-links' },
    admin: { label: 'Admin', name: 'Grace N.', shortName: 'Grace', defaultPage: 'admin-overview', search: 'Search users, orders, products and tickets...', quickLabel: 'Operations', quickPage: 'admin-orders' },
    superadmin: { label: 'Super Admin', name: 'Simon Awan', shortName: 'Simon', defaultPage: 'super-overview', search: 'Search the entire Classic Mart platform...', quickLabel: 'System Health', quickPage: 'super-security' },
    finance: { label: 'Finance', name: 'Finance Team', shortName: 'Finance', defaultPage: 'finance-overview', search: 'Search payments, refunds, payouts and settlements...', quickLabel: 'Reconcile', quickPage: 'finance-reconciliation' },
    support: { label: 'Support', name: 'Support Team', shortName: 'Support', defaultPage: 'support-overview', search: 'Search tickets, customers, orders and disputes...', quickLabel: 'Ticket Queue', quickPage: 'support-queue' },
    warehouse: { label: 'Warehouse', name: 'Kampala Fulfilment', shortName: 'Warehouse', defaultPage: 'warehouse-overview', search: 'Search inventory, orders, shipments and returns...', quickLabel: 'Dispatch', quickPage: 'warehouse-dispatch' },
    moderator: { label: 'Moderation', name: 'Trust & Safety', shortName: 'Trust', defaultPage: 'moderator-overview', search: 'Search products, reviews, sellers and risk cases...', quickLabel: 'Review Queue', quickPage: 'moderator-products' },
    business: { label: 'Business Buyer', name: 'Classic Business', shortName: 'Business', defaultPage: 'business-overview', search: 'Search orders, suppliers, documents and spend...', quickLabel: 'Orders', quickPage: 'business-orders' }
  };

  const rolePages = {
    superadmin: [
      ['super-overview','Overview','i-grid','Command centre','Platform Overview','Monitor marketplace growth, operations, trust, finance, and infrastructure from one command centre.','overview'],
      ['super-analytics','Platform Analytics','i-eye','Command centre','Platform Analytics','Compare revenue, traffic, retention, fulfilment, and conversion trends across the entire marketplace.','analytics'],
      ['super-users','All Users','i-user','People & access','User Management','Search, verify, suspend, restore, and understand every account on Classic Mart.','users'],
      ['super-roles','Roles & Permissions','i-shield','People & access','Roles & Permissions','Create controlled access policies for operational teams and platform administrators.','roles'],
      ['super-admins','Admin Accounts','i-user','People & access','Admin Accounts','Manage administrators, assigned departments, access status, and recent activity.','admins'],
      ['super-sellers','Sellers','i-bag','Marketplace','Seller Management','Review seller health, compliance, sales quality, and account standing.','sellers'],
      ['super-promoters','Promoters','i-award','Marketplace','Promoter Management','Track promoter quality, campaign performance, verification, and commission exposure.','promoters'],
      ['super-customers','Customers','i-user','Marketplace','Customer Management','Understand customer value, account status, retention, and support risk.','customers'],
      ['super-products','Product Moderation','i-box','Marketplace','Product Moderation','Approve listings, resolve policy flags, and maintain catalogue quality.','products'],
      ['super-categories','Category Control','i-grid','Marketplace','Category Control','Manage the global category tree, attributes, commission rules, and visibility.','categories'],
      ['super-orders','Global Orders','i-clipboard','Commerce','Global Orders','Supervise order flow, fulfilment exceptions, high-risk activity, and service levels.','orders'],
      ['super-finance','Payments & Finance','i-wallet','Commerce','Payments & Finance','Control payment settlement, marketplace revenue, refunds, reserves, and reconciliation.','finance'],
      ['super-commissions','Commission Rules','i-award','Commerce','Commission Rules','Manage seller fees, promoter rates, category rules, and incentive programmes.','commissions'],
      ['super-subscriptions','Subscriptions','i-card','Commerce','Subscriptions','Manage seller plans, promoter tiers, billing cycles, renewals, and plan adoption.','subscriptions'],
      ['super-disputes','Disputes & Risk','i-refresh','Trust & safety','Disputes & Risk','Resolve escalated disputes, payment risk, abuse signals, and protected transactions.','disputes'],
      ['super-reports','Reports Centre','i-download','Intelligence','Reports Centre','Build, schedule, and export reliable operational and financial reports.','reports'],
      ['super-audit','Audit Logs','i-eye','Trust & safety','Audit Logs','Review sensitive actions, login events, configuration changes, and data exports.','audit'],
      ['super-security','Security & System Health','i-shield','Trust & safety','Security & System Health','Monitor infrastructure availability, security controls, backups, and integration health.','security'],
      ['super-notifications','Platform Notifications','i-bell','Engagement','Platform Notifications','Create targeted announcements, transactional notices, and emergency communications.','notifications'],
      ['super-support','Escalated Support','i-support','Operations','Escalated Support','Handle high-priority marketplace cases and review support team performance.','support'],
      ['super-settings','System Settings','i-user','Configuration','System Settings','Configure global marketplace identity, currencies, taxes, policies, and integrations.','settings']
    ],
    admin: [
      ['admin-overview','Overview','i-grid','Operations','Admin Overview','Run day-to-day marketplace operations, approvals, fulfilment, content, and customer care.','overview'],
      ['admin-seller-approvals','Seller Approvals','i-bag','Approvals','Seller Approvals','Verify business documents, store readiness, and seller compliance before activation.','approvals'],
      ['admin-promoter-approvals','Promoter Approvals','i-award','Approvals','Promoter Approvals','Review promoter identity, channels, audience quality, and programme eligibility.','approvals'],
      ['admin-customers','Customers','i-user','People','Customer Accounts','Support customers, review account status, and resolve access or verification issues.','customers'],
      ['admin-products','Products','i-box','Catalogue','Product Management','Review listings, fix catalogue issues, and keep active products accurate and compliant.','products'],
      ['admin-categories','Categories','i-grid','Catalogue','Category Management','Maintain category structure, attributes, brands, and merchandising visibility.','categories'],
      ['admin-orders','Orders','i-clipboard','Commerce','Order Operations','Track fulfilment, intervene in exceptions, and maintain delivery service levels.','orders'],
      ['admin-returns','Returns & Refunds','i-refresh','Commerce','Returns & Refunds','Approve return requests, coordinate pickups, and monitor refund completion.','returns'],
      ['admin-payments','Payments','i-wallet','Commerce','Payment Operations','Review captured payments, failed transactions, refunds, and reconciliation exceptions.','finance'],
      ['admin-coupons','Coupons','i-tag','Growth','Coupon Management','Create controlled offers, define eligibility, and measure coupon usage.','coupons'],
      ['admin-campaigns','Campaigns','i-award','Growth','Campaign Management','Plan marketplace campaigns, assign inventory, and coordinate sellers and promoters.','campaigns'],
      ['admin-reviews','Reviews','i-star','Trust','Review Moderation','Protect authentic reviews and resolve flagged, abusive, or misleading content.','reviews'],
      ['admin-support','Support Tickets','i-support','Service','Support Tickets','Manage ticket queues, ownership, response time, and customer satisfaction.','support'],
      ['admin-content','Content & Banners','i-message','Content','Content Management','Publish homepage sections, campaign banners, help content, and marketplace announcements.','content'],
      ['admin-reports','Reports','i-download','Intelligence','Operational Reports','Export daily operational, seller, product, order, and customer reports.','reports'],
      ['admin-settings','Admin Settings','i-user','Configuration','Admin Settings','Manage notification preferences, assigned workflows, profile, and session security.','settings']
    ],
    seller: [
      ['seller-overview','Overview','i-grid','Store','Seller Overview','See sales, orders, inventory risk, customer satisfaction, and store actions at a glance.','overview'],
      ['seller-products','Products','i-box','Catalogue','My Products','Manage product information, publishing status, prices, images, and marketplace visibility.','products'],
      ['seller-add-product','Add Product','i-plus','Catalogue','Add a Product','Create a complete product listing with pricing, stock, variants, media, and delivery details.','form-product'],
      ['seller-inventory','Inventory','i-box','Catalogue','Inventory Management','Track stock levels, low-stock warnings, reserved quantities, and warehouse availability.','inventory'],
      ['seller-orders','Orders','i-clipboard','Fulfilment','Seller Orders','Accept, prepare, ship, and complete customer orders within marketplace service levels.','orders'],
      ['seller-shipping','Shipping','i-truck','Fulfilment','Shipping & Delivery','Manage pickup addresses, courier handover, tracking, and delivery performance.','shipping'],
      ['seller-returns','Returns','i-refresh','Fulfilment','Returns & Refunds','Review return reasons, approve requests, receive items, and follow refund status.','returns'],
      ['seller-customers','Customers','i-user','Relationships','Customers','Understand repeat buyers, customer value, questions, and post-purchase needs.','customers'],
      ['seller-promotions','Promotions','i-award','Growth','Promotions','Join marketplace campaigns and create product discounts that protect your margins.','campaigns'],
      ['seller-coupons','Coupons','i-tag','Growth','Seller Coupons','Create store-level coupon codes with usage, product, and customer restrictions.','coupons'],
      ['seller-earnings','Earnings','i-wallet','Finance','Earnings & Wallet','Review gross sales, fees, refunds, available balance, and upcoming settlement.','finance'],
      ['seller-payouts','Payouts','i-card','Finance','Payouts','Manage settlement methods, payout schedules, completed transfers, and payment holds.','payouts'],
      ['seller-analytics','Analytics','i-eye','Intelligence','Store Analytics','Measure traffic, conversion, products, customers, campaigns, and revenue trends.','analytics'],
      ['seller-reviews','Reviews','i-star','Relationships','Product Reviews','Read customer feedback, respond professionally, and improve product quality.','reviews'],
      ['seller-messages','Messages','i-message','Relationships','Customer Messages','Answer product questions, order enquiries, and platform conversations efficiently.','messages'],
      ['seller-store','Store Settings','i-bag','Configuration','Store Settings','Manage your store identity, business details, policies, pickup locations, and team access.','settings-store'],
      ['seller-subscription','Subscription','i-crown','Configuration','Seller Subscription','Compare plans, review current benefits, billing history, and upgrade options.','subscriptions']
    ],
    promoter: [
      ['promoter-overview','Overview','i-grid','Workspace','Promoter Overview','Track active campaigns, clicks, conversions, commissions, and opportunities in one place.','overview'],
      ['promoter-marketplace','Campaign Marketplace','i-award','Campaigns','Campaign Marketplace','Discover approved products and seller campaigns that match your audience.','campaigns-market'],
      ['promoter-campaigns','Active Campaigns','i-tag','Campaigns','Active Campaigns','Manage accepted campaigns, requirements, content deadlines, and performance.','campaigns'],
      ['promoter-links','Tracking Links','i-arrow-right','Promotion tools','Tracking Links','Create, organise, and monitor attributed product and campaign links.','links'],
      ['promoter-content','Content Library','i-message','Promotion tools','Content Library','Access approved product images, captions, campaign briefs, and brand guidelines.','content'],
      ['promoter-traffic','Traffic & Clicks','i-eye','Performance','Traffic & Clicks','Understand channel traffic, click quality, devices, locations, and engagement.','traffic'],
      ['promoter-conversions','Conversions & Orders','i-clipboard','Performance','Conversions & Orders','Track attributed orders, approval status, returns, and conversion value.','conversions'],
      ['promoter-commissions','Commissions','i-award','Finance','Commissions','Review pending, approved, reversed, and paid campaign commission.','commissions'],
      ['promoter-wallet','Wallet','i-wallet','Finance','Promoter Wallet','See available earnings, pending commission, bonuses, and wallet transactions.','finance'],
      ['promoter-payouts','Payouts','i-card','Finance','Payouts','Manage payout details, withdrawal requests, settlement timing, and payment history.','payouts'],
      ['promoter-analytics','Analytics','i-eye','Performance','Promoter Analytics','Compare campaigns, channels, content, products, and audience conversion trends.','analytics'],
      ['promoter-referrals','Referrals','i-user','Growth','Promoter Referrals','Invite qualified promoters, track activation, and earn referral bonuses.','referrals'],
      ['promoter-brands','Sellers & Brands','i-bag','Partnerships','Sellers & Brands','Follow trusted sellers, review collaboration invitations, and manage relationships.','brands'],
      ['promoter-messages','Messages','i-message','Partnerships','Messages','Communicate with sellers, campaign managers, and Classic Mart support.','messages'],
      ['promoter-profile','Profile Settings','i-user','Configuration','Promoter Profile','Manage channels, audience details, payout information, preferences, and security.','settings-promoter']
    ],
    finance: [
      ['finance-overview','Overview','i-grid','Finance','Finance Overview','Monitor captured funds, refunds, settlement exposure, payout risk, and reconciliation work.','overview'],
      ['finance-payments','Payments','i-card','Money movement','Payment Operations','Review provider status, captured payments, failures, chargebacks, and payment exceptions.','finance'],
      ['finance-refunds','Refunds','i-refresh','Money movement','Refund Operations','Track refund eligibility, approvals, provider completion, and unresolved money movement.','returns'],
      ['finance-payouts','Payouts','i-wallet','Money movement','Payout Operations','Review seller and promoter payouts, holds, submission status, and settlement evidence.','payouts'],
      ['finance-reconciliation','Reconciliation','i-check','Controls','Reconciliation Centre','Match provider truth to the internal ledger and resolve every exception without duplicate movement.','reports'],
      ['finance-disputes','Chargebacks & Disputes','i-shield','Controls','Financial Disputes','Investigate chargebacks, payment disputes, evidence deadlines, and protected balances.','disputes'],
      ['finance-reports','Reports','i-download','Intelligence','Finance Reports','Prepare settlement, revenue, refund, payout, and audit-ready financial exports.','reports'],
      ['finance-audit','Audit Trail','i-eye','Controls','Finance Audit Trail','Review privileged money actions, approvals, exports, and reconciliation decisions.','audit'],
      ['finance-settings','Finance Settings','i-user','Configuration','Finance Settings','Manage finance notifications, review preferences, sessions, and controlled workspace settings.','settings']
    ],
    support: [
      ['support-overview','Overview','i-grid','Service','Support Overview','See queue health, response time, escalations, CSAT, and the cases that need action now.','overview'],
      ['support-queue','Ticket Queue','i-support','Service','Support Ticket Queue','Own, prioritize, transfer, respond to, and resolve customer and partner support requests.','support'],
      ['support-customers','Customer Lookup','i-user','Service','Customer Lookup','Find customer history, order context, account state, and safe support actions in one place.','customers'],
      ['support-orders','Order Help','i-clipboard','Commerce','Order Support','Investigate order status, delivery exceptions, cancellations, and buyer-protection questions.','orders'],
      ['support-returns','Returns & Refunds','i-refresh','Commerce','Returns Support','Help customers through eligibility, pickup, inspection, refund status, and escalation.','returns'],
      ['support-disputes','Escalations','i-shield','Trust','Escalated Cases','Coordinate high-risk disputes, evidence, specialist review, and documented outcomes.','disputes'],
      ['support-reviews','Review Issues','i-star','Trust','Review Issues','Handle review disputes and authenticity questions without bypassing moderation controls.','reviews'],
      ['support-reports','Service Reports','i-download','Intelligence','Support Reports','Track SLA, backlog, transfer quality, CSAT, resolution reasons, and staffing trends.','reports'],
      ['support-settings','Support Settings','i-user','Configuration','Support Settings','Manage queue preferences, notifications, profile, sessions, and workspace security.','settings']
    ],
    warehouse: [
      ['warehouse-overview','Overview','i-grid','Fulfilment','Warehouse Overview','Monitor receiving, inventory, picking, packing, dispatch, exceptions, and return intake.','overview'],
      ['warehouse-inventory','Inventory','i-box','Stock','Inventory Control','Track available, reserved, damaged, low-stock, and cycle-count quantities by SKU.','inventory'],
      ['warehouse-receiving','Receiving','i-download','Stock','Receiving','Record inbound stock, purchase references, variances, damage, and put-away readiness.','inventory'],
      ['warehouse-picking','Picking','i-clipboard','Fulfilment','Picking Queue','Prioritize paid orders, pick exact SKUs, confirm quantities, and surface stock exceptions.','orders'],
      ['warehouse-packing','Packing','i-box','Fulfilment','Packing Station','Verify picked items, package safely, prepare labels, and prevent duplicate completion.','orders'],
      ['warehouse-dispatch','Dispatch','i-truck','Fulfilment','Dispatch','Handover parcels to couriers with custody evidence, tracking, and service-level visibility.','shipping'],
      ['warehouse-returns','Return Intake','i-refresh','Reverse logistics','Return Intake','Receive returned parcels, record condition, route inspection, and update stock disposition.','returns'],
      ['warehouse-reports','Warehouse Reports','i-download','Intelligence','Warehouse Reports','Review stock movement, fulfilment speed, variance, courier handover, and cycle-count accuracy.','reports'],
      ['warehouse-settings','Warehouse Settings','i-user','Configuration','Warehouse Settings','Manage workstation preferences, notifications, profile, and secure session controls.','settings']
    ],
    moderator: [
      ['moderator-overview','Overview','i-grid','Trust','Moderation Overview','See catalogue, review, seller, and risk queues with clear priority and evidence context.','overview'],
      ['moderator-products','Product Queue','i-box','Catalogue trust','Product Moderation','Review prohibited items, counterfeit risk, listing accuracy, evidence, and appeals.','products'],
      ['moderator-reviews','Review Queue','i-star','Content trust','Review Moderation','Protect verified reviews, detect manipulation, and resolve disputes with recorded reasons.','reviews'],
      ['moderator-sellers','Seller Compliance','i-bag','Marketplace trust','Seller Compliance','Review seller health, policy signals, verification state, and corrective action.','sellers'],
      ['moderator-disputes','Risk Cases','i-shield','Risk','Risk Cases','Investigate abuse signals, protected transactions, evidence, escalation, and appeal status.','disputes'],
      ['moderator-audit','Moderation Audit','i-eye','Controls','Moderation Audit','Review sensitive moderation actions, evidence access, exports, and decision history.','audit'],
      ['moderator-reports','Trust Reports','i-download','Intelligence','Trust & Safety Reports','Measure queue age, decision quality, appeal outcomes, repeat abuse, and policy trends.','reports'],
      ['moderator-settings','Moderation Settings','i-user','Configuration','Moderation Settings','Manage alerts, profile, review preferences, sessions, and account security.','settings']
    ],
    business: [
      ['business-overview','Overview','i-grid','Business','Business Overview','Track company purchasing, supplier activity, order status, spend, and finance controls.','overview'],
      ['business-orders','Business Orders','i-clipboard','Procurement','Business Orders','Manage company purchases, approvals, delivery status, and order documents.','orders'],
      ['business-suppliers','Suppliers','i-bag','Procurement','Supplier Directory','Review approved marketplace sellers, relationship quality, and supply performance.','sellers'],
      ['business-payments','Payments','i-card','Finance','Business Payments','Track company payment activity, refunds, wallet use, and reconciliation context.','finance'],
      ['business-reports','Spend Reports','i-download','Intelligence','Spend Reports','Review procurement spend, supplier mix, order performance, and exportable finance summaries.','reports'],
      ['business-settings','Business Settings','i-user','Configuration','Business Settings','Manage company profile, notifications, sessions, and secure workspace preferences.','settings']
    ]
  };

  const presets = {
    users: {
      stats: [['Total accounts','48,290','+8.4%'],['Verified','42,816','88.7%'],['Active today','9,420','+11.2%'],['Restricted','126','−14']],
      columns: ['User','Type','Contact','Status','Joined'],
      rows: [['Asha Namutebi','Customer','asha@example.com','Active','12 Sep 2026'],['Musa Retail Ltd','Seller','sales@musaretail.com','Verified','11 Sep 2026'],['Brian Media','Promoter','hello@brianmedia.com','Review','10 Sep 2026'],['Nile Home Store','Seller','team@nilehome.store','Active','08 Sep 2026']],
      insights: ['Customer verification completion is 6% higher this month.','Twenty-three accounts require document review.','Restricted account appeals are within the 24-hour target.']
    },
    roles: {
      stats: [['Roles','10','Controlled'],['Permission sets','34','+3'],['Admins online','18','Now'],['Access reviews','7','Due']],
      columns: ['Role','Members','Scope','Last review','Status'],
      rows: [['Super Admin','3','Full platform','01 Sep 2026','Protected'],['Operations Admin','14','Operations','09 Sep 2026','Active'],['Finance Admin','6','Finance','08 Sep 2026','Active'],['Support Lead','11','Support','05 Sep 2026','Review due']],
      insights: ['Least-privilege review is due for the Support Lead role.','Two custom roles have unused permissions.','All super-admin accounts have multi-factor authentication.']
    },
    admins: {
      stats: [['Administrators','34','+2'],['Online now','18','53%'],['MFA protected','34','100%'],['Reviews due','4','This week']],
      columns: ['Administrator','Department','Access','Last active','Status'],
      rows: [['Grace N.','Operations','Operations Admin','2 min ago','Active'],['Joseph K.','Finance','Finance Admin','11 min ago','Active'],['Lydia A.','Trust & Safety','Risk Manager','1 hour ago','Active'],['Peter O.','Content','Content Editor','Yesterday','Review']],
      insights: ['No privileged login anomalies were detected today.','Four quarterly access reviews are due this week.','Content team coverage is below target for the evening shift.']
    },
    sellers: {
      stats: [['Active sellers','3,842','+6.1%'],['GMV this month','UGX 4.8B','+12.4%'],['Healthy stores','91.2%','+1.8%'],['Under review','38','−5']],
      columns: ['Store','Category','Monthly sales','Health','Status'],
      rows: [['Amina Stores','Fashion','UGX 18.4M','96%','Active'],['Nile Home Store','Home','UGX 12.7M','91%','Active'],['Kampala Tech Hub','Electronics','UGX 26.9M','88%','Watch'],['Pearl Beauty','Beauty','UGX 8.2M','94%','Active']],
      insights: ['Electronics return rates improved by 1.4 percentage points.','Thirty-eight sellers need compliance follow-up.','Top 10% of sellers contribute 47% of marketplace GMV.']
    },
    promoters: {
      stats: [['Active promoters','1,294','+9.6%'],['Attributed GMV','UGX 680M','+18.2%'],['Avg. conversion','4.8%','+0.6%'],['Pending review','21','−8']],
      columns: ['Promoter','Primary channel','Conversions','Commission','Status'],
      rows: [['Daniel Okello','TikTok','184','UGX 2.8M','Active'],['Nadia Reviews','YouTube','126','UGX 2.1M','Active'],['Kato Deals','WhatsApp','98','UGX 1.4M','Review'],['Urban Style UG','Instagram','76','UGX 980K','Active']],
      insights: ['Video-led campaigns convert 38% better than static content.','Twenty-one applications need audience verification.','Fashion and beauty produce the strongest promoter ROAS.']
    },
    customers: {
      stats: [['Customers','43,120','+8.7%'],['Repeat buyers','38.4%','+2.2%'],['Avg. order value','UGX 116K','+4.1%'],['At-risk accounts','82','−12']],
      columns: ['Customer','Orders','Lifetime value','Last order','Status'],
      rows: [['Asha Namutebi','24','UGX 3.8M','Today','VIP'],['John Otema','12','UGX 1.7M','Yesterday','Active'],['Mary Akello','8','UGX 920K','08 Sep 2026','Active'],['Sam Kintu','3','UGX 340K','28 Aug 2026','Follow-up']],
      insights: ['Repeat purchase rate reached a six-month high.','Home and beauty customers have the highest retention.','Eighty-two accounts need proactive support follow-up.']
    },
    approvals: {
      stats: [['Pending','27','−9'],['Approved today','18','+5'],['Needs changes','7','Today'],['Avg. review time','3.2h','−18%']],
      columns: ['Applicant','Business / Channel','Submitted','Risk check','Status'],
      rows: [['Mirembe Fashion','Fashion retail','Today 09:42','Passed','Ready'],['Juba Tech Store','Electronics','Today 08:15','Review','Documents'],['East Side Media','TikTok · 82K','Yesterday','Passed','Ready'],['Pearl Deals','WhatsApp · 19K','Yesterday','Review','Clarification']],
      insights: ['Nine applications are ready for one-click approval.','Three tax documents expire within 30 days.','Average review time is comfortably below the 6-hour target.']
    },
    products: {
      stats: [['Active products','82,450','+7.2%'],['Pending review','186','−22'],['Low quality flags','43','−11'],['Conversion rate','4.6%','+0.3%']],
      columns: ['Product','Seller','Price','Stock','Status'],
      rows: [['Classic Wireless Headphones','Kampala Tech Hub','UGX 185K','84','Active'],['Premium Leather Handbag','Amina Stores','UGX 142K','31','Review'],['Urban Travel Backpack','Nile Home Store','UGX 96K','12','Low stock'],['Smart Classic Watch','Kampala Tech Hub','UGX 310K','46','Active']],
      insights: ['Listings with five or more images convert 19% better.','One hundred eighty-six products await moderation.','Accessories have the strongest catalogue growth this week.']
    },
    categories: {
      stats: [['Categories','42','Stable'],['Subcategories','318','+6'],['Attributes','1,284','+24'],['Hidden nodes','9','Review']],
      columns: ['Category','Products','Commission','Conversion','Visibility'],
      rows: [['Fashion','18,420','8.0%','5.2%','Visible'],['Electronics','13,870','6.5%','4.1%','Visible'],['Home & Living','11,205','7.0%','4.8%','Visible'],['Sports','5,604','7.5%','3.9%','Review']],
      insights: ['Fashion contributes the largest share of marketplace visits.','Nine category nodes have incomplete required attributes.','Home & Living conversion rose after the navigation update.']
    },
    orders: {
      stats: [['Orders today','2,486','+13.1%'],['In fulfilment','1,128','45.4%'],['Delivered','1,034','+9.2%'],['Exceptions','36','−7']],
      columns: ['Order','Customer','Seller','Total','Status'],
      rows: [['CM-128842','Asha Namutebi','Amina Stores','UGX 248K','Processing'],['CM-128841','John Otema','Kampala Tech Hub','UGX 365K','Shipped'],['CM-128838','Mary Akello','Nile Home Store','UGX 132K','Delivered'],['CM-128829','Sam Kintu','Pearl Beauty','UGX 89K','Attention']],
      insights: ['Ninety-four percent of orders are within fulfilment SLA.','Thirty-six orders need an operational decision.','Same-day handover improved by 8% this week.']
    },
    returns: {
      stats: [['Open requests','84','−6'],['Pickup scheduled','41','Today'],['Refund pending','28','UGX 7.2M'],['Return rate','3.4%','−0.4%']],
      columns: ['Return','Order','Reason','Value','Status'],
      rows: [['RT-93482','CM-128720','Size mismatch','UGX 118K','Pickup'],['RT-93475','CM-128694','Damaged item','UGX 246K','Review'],['RT-93464','CM-128611','Not as described','UGX 92K','Refunding'],['RT-93442','CM-128504','Changed mind','UGX 64K','Approved']],
      insights: ['Return rate is below the 4% marketplace target.','Fashion sizing remains the largest return reason.','Twenty-eight approved refunds require reconciliation.']
    },
    finance: {
      stats: [['Gross value','UGX 186M','Today'],['Net revenue','UGX 17.8M','+12.6%'],['Pending settlement','UGX 42M','Scheduled'],['Failed payments','0.8%','−0.2%']],
      columns: ['Transaction','Source','Gross','Fees','Status'],
      rows: [['TX-809422','Order CM-128842','UGX 248K','UGX 19.8K','Captured'],['TX-809418','Order CM-128841','UGX 365K','UGX 23.7K','Captured'],['RF-118204','Return RT-93464','−UGX 92K','UGX 0','Refunding'],['ST-60982','Seller settlement','UGX 18.2M','UGX 0','Scheduled']],
      insights: ['Payment success rate is 99.2% across all gateways.','Mobile money represents 61% of successful payments.','One settlement batch has a bank verification warning.']
    },
    commissions: {
      stats: [['Commission earned','UGX 28.4M','This month'],['Pending approval','UGX 6.8M','+14%'],['Paid out','UGX 18.9M','On schedule'],['Reversed','UGX 640K','2.2%']],
      columns: ['Rule / Campaign','Applies to','Rate','Value','Status'],
      rows: [['Fashion base rate','Seller category','8.0%','UGX 12.8M','Active'],['Creator launch bonus','Promoter campaign','12.0%','UGX 4.2M','Active'],['Electronics base rate','Seller category','6.5%','UGX 7.6M','Active'],['New seller incentive','Seller cohort','4.0%','UGX 1.1M','Ending']],
      insights: ['Current blended marketplace commission is 7.4%.','Promoter bonus programmes lifted campaign GMV by 16%.','One incentive programme ends within seven days.']
    },
    subscriptions: {
      stats: [['Paid accounts','2,184','+7.8%'],['Monthly recurring','UGX 96M','+9.1%'],['Renewal rate','92.4%','+1.3%'],['Trials ending','64','7 days']],
      columns: ['Plan','Members','Price','Renewal','Status'],
      rows: [['Seller Growth','1,284','UGX 49K/mo','94.1%','Active'],['Seller Pro','642','UGX 119K/mo','91.8%','Active'],['Promoter Plus','258','UGX 29K/mo','89.6%','Active'],['Enterprise','18','Custom','100%','Active']],
      insights: ['Seller Growth remains the strongest acquisition plan.','Sixty-four trials end within the next seven days.','Annual billing adoption rose to 31%.']
    },
    disputes: {
      stats: [['Open disputes','46','−8'],['High priority','7','Today'],['Resolved this week','82','+14'],['Protected value','UGX 23M','Held']],
      columns: ['Case','Parties','Issue','Value','Status'],
      rows: [['DP-20482','Customer / Seller','Item authenticity','UGX 480K','Investigation'],['DP-20474','Seller / Promoter','Attribution conflict','UGX 1.2M','Evidence'],['DP-20461','Customer / Seller','Missing delivery','UGX 165K','Decision'],['DP-20435','Seller / Platform','Fee appeal','UGX 680K','Resolved']],
      insights: ['Seven disputes need senior review today.','Average resolution time improved to 31 hours.','Delivery evidence resolves 62% of customer-seller cases.']
    },
    reports: {
      stats: [['Saved reports','28','+3'],['Scheduled','12','Active'],['Exports today','46','CSV / PDF'],['Data freshness','6 min','Healthy']],
      columns: ['Report','Owner','Frequency','Last run','Status'],
      rows: [['Daily Marketplace Pulse','Operations','Daily','Today 08:00','Ready'],['Seller Settlement Detail','Finance','Weekly','Monday','Ready'],['Campaign Attribution','Growth','Weekly','Friday','Scheduled'],['Trust & Safety Summary','Risk','Monthly','01 Sep','Ready']],
      insights: ['All scheduled reports completed successfully.','Marketplace data warehouse freshness is six minutes.','Three new custom reports were created this month.']
    },
    audit: {
      stats: [['Events today','18,420','Normal'],['Privileged actions','126','Reviewed'],['Failed logins','34','−22%'],['Open alerts','2','Low']],
      columns: ['Event','Actor','Resource','Time','Result'],
      rows: [['Commission rule updated','Simon Awan','Fashion rate','10:32','Success'],['Seller restored','Grace N.','Amina Stores','10:14','Success'],['Export requested','Joseph K.','Finance report','09:58','Success'],['Login challenge','Unknown device','Admin portal','09:41','Blocked']],
      insights: ['No critical security events were detected.','Two low-risk login alerts await acknowledgement.','Privileged exports are within the expected baseline.']
    },
    security: {
      stats: [['Availability','99.98%','30 days'],['API latency','184 ms','Healthy'],['Backups','Completed','02:00'],['Security alerts','2','Low']],
      columns: ['Service','Region / Provider','Latency','Availability','Status'],
      rows: [['Marketplace API','East Africa','184 ms','99.99%','Healthy'],['Payment gateway','Pesapal','231 ms','99.96%','Healthy'],['Media storage','Global CDN','96 ms','100%','Healthy'],['Notification service','Africa region','312 ms','99.82%','Watch']],
      insights: ['All critical systems are operational.','Notification latency is elevated but within tolerance.','Last encrypted backup completed and passed verification.']
    },
    notifications: {
      stats: [['Sent today','84,260','+18%'],['Delivery rate','98.7%','Healthy'],['Open rate','42.6%','+3.2%'],['Scheduled','8','Upcoming']],
      columns: ['Communication','Audience','Channel','Delivery','Status'],
      rows: [['Order delay advisory','Affected customers','Push + SMS','99.2%','Sent'],['Weekend fashion offer','Silver members','Email + Push','98.4%','Scheduled'],['Seller policy update','All sellers','Email','99.8%','Sent'],['System maintenance','Admins','Email + In-app','100%','Draft']],
      insights: ['Transactional notifications maintain a 99% delivery rate.','Push messages outperform email for time-sensitive offers.','Eight communications are scheduled this week.']
    },
    support: {
      stats: [['Open tickets','286','−12%'],['First response','18 min','−4 min'],['Resolved today','194','+21'],['CSAT','94.2%','+1.1%']],
      columns: ['Ticket','Customer / Account','Topic','Owner','Status'],
      rows: [['TK-58420','Asha Namutebi','Order delivery','Sarah','Open'],['TK-58416','Amina Stores','Payout delay','Michael','Priority'],['TK-58402','Daniel Okello','Link attribution','Patricia','Waiting'],['TK-58394','John Otema','Refund status','Sarah','Resolved']],
      insights: ['First response time is below the 20-minute target.','Payout and delivery topics account for 41% of tickets.','Customer satisfaction improved for the third week.']
    },
    settings: {
      stats: [['Configurations','148','Managed'],['Integrations','12','11 healthy'],['Currencies','5','Active'],['Policy updates','3','Draft']],
      columns: ['Setting group','Owner','Last updated','Environment','Status'],
      rows: [['Marketplace identity','Platform','08 Sep 2026','Production','Active'],['Taxes & invoices','Finance','06 Sep 2026','Production','Active'],['Email delivery','Engineering','04 Sep 2026','Production','Healthy'],['Return policy','Operations','01 Sep 2026','Draft','Review']],
      insights: ['One integration requires renewed credentials.','Three policy changes are waiting for approval.','All production configuration changes are audited.']
    },
    inventory: {
      stats: [['Stock units','6,842','Across 186 SKUs'],['Low stock','14','Action'],['Out of stock','3','−2'],['Reserved','284','Open orders']],
      columns: ['Product','SKU','Available','Reserved','Status'],
      rows: [['Classic Wireless Headphones','CW-HDP-01','84','12','Healthy'],['Premium Leather Handbag','PL-HBG-04','31','6','Healthy'],['Urban Travel Backpack','UT-BPK-02','12','8','Low stock'],['Classic White Sneakers','CW-SNK-07','0','0','Out of stock']],
      insights: ['Fourteen products are below their reorder point.','Reserved stock is fully matched to open orders.','Sneaker restock is expected on 15 Sep.']
    },
    shipping: {
      stats: [['Ready to ship','38','Today'],['In transit','126','Active'],['On-time handover','96.8%','+1.4%'],['Delivery issues','4','Action']],
      columns: ['Shipment','Order','Courier','Handover','Status'],
      rows: [['SH-98241','CM-128842','SafeBoda','Today 14:00','Ready'],['SH-98232','CM-128841','DHL eCommerce','Today 11:30','In transit'],['SH-98194','CM-128702','G4S','Yesterday','Delivered'],['SH-98182','CM-128668','SafeBoda','Yesterday','Delayed']],
      insights: ['Handover compliance is above the 95% target.','Four deliveries need seller or courier follow-up.','SafeBoda is the fastest local courier this week.']
    },
    campaigns: {
      stats: [['Active campaigns','12','+2'],['Campaign revenue','UGX 42M','+18%'],['Discount cost','UGX 3.6M','8.6%'],['Products enrolled','284','+46']],
      columns: ['Campaign','Period','Products','Revenue','Status'],
      rows: [['Mid-Year Fashion','10–20 Sep','84','UGX 18.4M','Active'],['Classic Tech Week','15–22 Sep','46','UGX 12.8M','Scheduled'],['Home Refresh','01–14 Sep','72','UGX 8.1M','Active'],['Beauty Spotlight','20–27 Sep','38','UGX 0','Draft']],
      insights: ['Mid-Year Fashion is 14% above its revenue target.','Forty-six products await campaign confirmation.','Campaign-funded discounts maintain healthy seller margins.']
    },
    'campaigns-market': {
      stats: [['Available campaigns','38','Matched'],['High commission','9','10%+'],['Ending soon','6','This week'],['Saved','12','Opportunities']],
      columns: ['Campaign','Seller','Commission','Deadline','Fit'],
      rows: [['Classic Tech Week','Kampala Tech Hub','12%','14 Sep','96%'],['Mid-Year Fashion','Amina Stores','10%','12 Sep','92%'],['Home Refresh','Nile Home Store','8%','18 Sep','88%'],['Beauty Spotlight','Pearl Beauty','14%','19 Sep','84%']],
      insights: ['Technology campaigns best match your recent audience.','Nine opportunities offer commission above 10%.','Two invited campaigns need a response today.']
    },
    coupons: {
      stats: [['Active coupons','18','+3'],['Redemptions','1,842','This month'],['Revenue influenced','UGX 36M','+16%'],['Discount cost','UGX 2.9M','8.1%']],
      columns: ['Code','Offer','Usage','Revenue','Status'],
      rows: [['CLASSIC10','10% off','684 / 2,000','UGX 14.2M','Active'],['FREESHIP','Free delivery','482 / 1,000','UGX 8.6M','Active'],['WELCOME15','15% first order','396 / 800','UGX 7.8M','Active'],['TECH5','5% electronics','280 / 500','UGX 5.4M','Ending']],
      insights: ['CLASSIC10 has the best revenue-to-discount ratio.','New-customer coupons lifted first conversion by 11%.','One coupon reaches its usage limit within three days.']
    },
    reviews: {
      stats: [['Average rating','4.6 / 5','+0.1'],['New reviews','128','This week'],['Awaiting response','18','Action'],['Flagged','6','Review']],
      columns: ['Product / Review','Customer','Rating','Submitted','Status'],
      rows: [['Classic Wireless Headphones','Asha Namutebi','5.0','Today','Published'],['Premium Leather Handbag','Mary Akello','4.0','Yesterday','Needs reply'],['Urban Travel Backpack','John Otema','4.5','10 Sep','Published'],['Smart Classic Watch','Sam Kintu','2.0','09 Sep','Flagged']],
      insights: ['Fast seller responses improve ratings by an average of 0.3.','Six reviews are in the moderation queue.','Product quality praise increased after the latest stock intake.']
    },
    content: {
      stats: [['Published assets','284','+18'],['Drafts','23','In progress'],['Scheduled','14','Upcoming'],['Approval queue','7','Action']],
      columns: ['Asset','Placement / Type','Owner','Publish date','Status'],
      rows: [['Mid-Year Fashion hero','Homepage banner','Content team','Today','Live'],['Classic Tech Week tiles','Campaign collection','Grace N.','15 Sep','Scheduled'],['Seller policy update','Help article','Operations','18 Sep','Review'],['Promoter launch kit','Content pack','Growth','20 Sep','Draft']],
      insights: ['Homepage hero engagement is 8.2% above average.','Seven assets need final brand review.','Scheduled content coverage is complete through 20 September.']
    },
    payouts: {
      stats: [['Available balance','UGX 4.8M','Ready'],['Pending clearance','UGX 1.7M','7 days'],['Paid this month','UGX 8.2M','+14%'],['Next payout','15 Sep','Bank']],
      columns: ['Payout','Period / Method','Amount','Requested','Status'],
      rows: [['PO-78421','Bank •••• 9421','UGX 2.8M','08 Sep','Completed'],['PO-78504','Bank •••• 9421','UGX 3.4M','12 Sep','Scheduled'],['PO-77982','Mobile money ••7217','UGX 1.6M','30 Jun','Completed'],['PO-77561','Bank •••• 9421','UGX 2.1M','15 Jun','Completed']],
      insights: ['Your next scheduled payout is on 15 Sep.','No payout verification issues are open.','Average settlement time is 1.8 business days.']
    },
    analytics: {
      stats: [['Revenue','UGX 42.8M','+18.4%'],['Visitors','128,420','+12.1%'],['Conversion','4.8%','+0.6%'],['Repeat rate','36.2%','+2.4%']],
      columns: ['Segment','Visitors','Conversion','Revenue','Change'],
      rows: [['Direct / Store','42,840','5.6%','UGX 16.8M','+14.2%'],['Campaign links','34,260','6.4%','UGX 13.1M','+22.8%'],['Marketplace search','28,920','4.2%','UGX 8.6M','+9.4%'],['Social referral','22,400','3.8%','UGX 4.3M','+18.6%']],
      insights: ['Campaign traffic is your fastest-growing revenue source.','Mobile conversion improved after checkout optimisation.','Repeat customers generate 44% of current revenue.']
    },
    messages: {
      stats: [['Open conversations','24','−6'],['Unread','8','Action'],['Response time','14 min','−3 min'],['Resolved today','31','+9']],
      columns: ['Conversation','Topic','Last message','Owner','Status'],
      rows: [['Asha Namutebi','Product availability','8 min ago','You','Unread'],['Classic Mart Support','Payout verification','32 min ago','Support','Open'],['Kampala Tech Hub','Campaign assets','1 hour ago','Daniel','Open'],['John Otema','Delivery question','Yesterday','You','Resolved']],
      insights: ['Average response time is below the 20-minute target.','Eight conversations need a reply.','Product availability is the most common topic today.']
    },
    links: {
      stats: [['Active links','86','+12'],['Clicks today','4,820','+21%'],['Conversions','184','3.8%'],['Attributed value','UGX 18.6M','+17%']],
      columns: ['Tracking link','Campaign / Product','Clicks','Conversions','Status'],
      rows: [['cm.art/daniel-tech','Classic Tech Week','1,842','82','Active'],['cm.art/fashion-midyear','Mid-Year Fashion','1,236','54','Active'],['cm.art/home-refresh','Home Refresh','984','32','Active'],['cm.art/watch-review','Smart Classic Watch','758','16','Active']],
      insights: ['Your technology link has the strongest conversion rate.','WhatsApp contributes 46% of attributed clicks.','Twelve new tracking links were created this month.']
    },
    traffic: {
      stats: [['Clicks','38,420','+19%'],['Unique visitors','31,840','+17%'],['Quality score','92 / 100','Strong'],['Bounce rate','28.6%','−2.4%']],
      columns: ['Channel','Clicks','Unique','Quality','Change'],
      rows: [['TikTok','14,820','12,440','94','+26%'],['WhatsApp','10,640','8,920','96','+18%'],['Instagram','8,420','6,880','89','+14%'],['YouTube','4,540','3,600','91','+11%']],
      insights: ['TikTok is your fastest-growing acquisition channel.','WhatsApp delivers the highest-quality traffic.','Evening content posts outperform morning posts by 22%.']
    },
    conversions: {
      stats: [['Attributed orders','642','+18%'],['Approved','514','80.1%'],['Pending','96','Validation'],['Returned','32','5.0%']],
      columns: ['Order','Campaign','Order value','Commission','Status'],
      rows: [['CM-128842','Classic Tech Week','UGX 248K','UGX 29.8K','Approved'],['CM-128804','Mid-Year Fashion','UGX 186K','UGX 18.6K','Pending'],['CM-128772','Home Refresh','UGX 312K','UGX 25K','Approved'],['CM-128698','Beauty Spotlight','UGX 94K','UGX 13.2K','Returned']],
      insights: ['Approved conversion rate is above the programme average.','Ninety-six orders remain in the validation window.','Return-adjusted campaign value grew 15% this month.']
    },
    referrals: {
      stats: [['Invited','48','+6'],['Activated','31','64.6%'],['Active promoters','24','77.4%'],['Bonus earned','UGX 1.2M','+18%']],
      columns: ['Referral','Channel','Joined','Performance','Status'],
      rows: [['Sarah Media','Instagram','04 Sep','18 conversions','Active'],['Kampala Deals','WhatsApp','28 Jun','42 conversions','Active'],['Nile Reviews','YouTube','22 Jun','7 conversions','Growing'],['Pearl Fashion','TikTok','18 Jun','0 conversions','Onboarding']],
      insights: ['Your referral activation rate is above the platform average.','Two referred promoters are close to bonus qualification.','WhatsApp referrals reach first conversion fastest.']
    },
    brands: {
      stats: [['Partner sellers','18','+3'],['Open invitations','6','Action'],['Active collaborations','12','Healthy'],['Repeat partners','72%','+6%']],
      columns: ['Seller / Brand','Category','Campaigns','Revenue','Relationship'],
      rows: [['Kampala Tech Hub','Electronics','8','UGX 12.4M','Preferred'],['Amina Stores','Fashion','6','UGX 8.8M','Active'],['Nile Home Store','Home','4','UGX 4.2M','Active'],['Pearl Beauty','Beauty','3','UGX 2.6M','Invited']],
      insights: ['Six collaboration invitations need a response.','Technology partners generate your highest average commission.','Repeat seller partnerships improved campaign acceptance.']
    }
  };

  const overviewByRole = {
    superadmin: { stats: [['Marketplace GMV','UGX 4.8B','+12.4%'],['Orders','62,840','+13.1%'],['Active sellers','3,842','+6.1%'],['System health','99.98%','Healthy']], focus: ['Review 7 high-priority disputes','Approve quarterly access review','Confirm seller settlement batch'], activity: ['Marketplace GMV passed UGX 4.8B this month','Payment success improved to 99.2%','Thirty-eight sellers entered compliance review'] },
    admin: { stats: [['Orders today','2,486','+13.1%'],['Pending approvals','27','−9'],['Open tickets','286','−12%'],['Product reviews','186','−22']], focus: ['Approve 9 ready seller applications','Resolve 36 order exceptions','Publish Classic Tech Week content'], activity: ['First-response time improved to 18 minutes','Return rate dropped below 3.5%','Campaign inventory reached 284 products'] },
    seller: { stats: [['Sales this month','UGX 18.4M','+16.8%'],['Orders','284','+12.2%'],['Conversion','5.6%','+0.7%'],['Store rating','4.7 / 5','+0.1']], focus: ['Restock 14 low-stock products','Prepare 38 orders for handover','Reply to 8 customer messages'], activity: ['Classic Wireless Headphones became your top product','Payout of UGX 3.4M is scheduled for 15 Sep','Store health score improved to 96%'] },
    promoter: { stats: [['Commission','UGX 4.8M','+18.4%'],['Clicks','38,420','+19%'],['Conversions','642','+18%'],['Active campaigns','12','+2']], focus: ['Respond to 2 campaign invitations','Create content for Classic Tech Week','Verify payout method before 15 Sep'], activity: ['Technology campaign conversion reached 6.4%','WhatsApp generated 46% of attributed clicks','UGX 3.4M payout is scheduled for 15 Sep'] },
    finance: { stats: [['Captured today','UGX 286M','99.2% success'],['Refund queue','18','6 urgent'],['Payout exposure','UGX 74M','Controlled'],['Reconciliation','99.7%','3 exceptions']], focus: ['Resolve 3 provider mismatches','Review 6 urgent refunds','Confirm the next payout batch'], activity: ['Pesapal reconciliation is within tolerance','No duplicate payout attempts detected','Refund completion improved this week'] },
    support: { stats: [['Open tickets','286','−12%'],['First response','18 min','On target'],['Escalations','14','Needs action'],['CSAT','94.2%','+1.1%']], focus: ['Handle 14 escalated tickets','Clear 21 waiting customer replies','Review transfer quality for the morning shift'], activity: ['Delivery questions remain the top contact reason','First response improved by four minutes','CSAT rose for the third week'] },
    warehouse: { stats: [['Ready to dispatch','38','Today'],['Pick queue','64','In progress'],['Inventory accuracy','99.4%','Healthy'],['Exceptions','7','Action']], focus: ['Dispatch 38 packed orders','Investigate 4 stock variances','Receive the 14:00 supplier intake'], activity: ['On-time handover remains above target','Three SKUs were replenished this morning','No duplicate completion events detected'] },
    moderator: { stats: [['Open reviews','186','−22'],['High risk','7','Priority'],['Appeals','18','In review'],['Decision quality','97.1%','Healthy']], focus: ['Review 7 high-risk listings','Resolve 6 review-manipulation cases','Close 4 seller compliance appeals'], activity: ['Counterfeit queue age improved','Review appeals remain within SLA','Evidence completeness increased this week'] },
    business: { stats: [['Spend this month','UGX 42.6M','+8.1%'],['Open orders','28','6 in transit'],['Approved suppliers','18','Healthy'],['Savings','UGX 4.2M','+11.0%']], focus: ['Approve 4 pending purchases','Review 2 delayed deliveries','Download the monthly spend report'], activity: ['Electronics spend is below budget','Supplier on-time performance improved','Two repeat purchases are ready to reorder'] }
  };

  const formPages = new Set(['form-product','settings-store','settings-promoter','settings']);
  const settingsPresets = new Set(['settings-store','settings-promoter','settings']);

  let currentRole = 'customer';
  let customerNavMarkup = '';
  let customerSidebarCardMarkup = '';

  function readStoredRole() {
    try { return window.localStorage.getItem('classicMartWorkspace'); }
    catch (error) { return null; }
  }

  function storeRole(role) {
    try { window.localStorage.setItem('classicMartWorkspace', role); }
    catch (error) { /* Local files and privacy modes may disable storage. */ }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  }

  function icon(id) {
    return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
  }

  function statusClass(value) {
    const text = String(value).toLowerCase();
    if (/active|healthy|ready|approved|completed|success|published|visible|protected|captured|delivered|preferred|live|vip/.test(text)) return 'good';
    if (/review|pending|scheduled|processing|watch|waiting|documents|clarification|draft|growing|onboarding|pickup/.test(text)) return 'warn';
    if (/blocked|restricted|failed|attention|delayed|flagged|out of stock|priority/.test(text)) return 'bad';
    return 'neutral';
  }

  function presetFor(page) {
    if (page[6] === 'overview') return null;
    return presets[page[6]] || presets.settings;
  }

  function metricCards(stats) {
    return `<section class="role-metric-grid">${stats.map(([label,value,change], index) => `
      <article class="role-metric panel">
        <span class="role-metric-icon tone-${(index % 4) + 1}">${icon(['i-eye','i-clipboard','i-wallet','i-award'][index % 4])}</span>
        <div><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(change)}</span></div>
      </article>`).join('')}</section>`;
  }

  function tableMarkup(page, data) {
    return `<section class="panel role-table-panel">
      <div class="role-panel-head">
        <div><h2>${esc(page[4])} records</h2><p>Live operational sample data for this workspace.</p></div>
        <div class="role-table-tools">
          <label class="role-mini-search">${icon('i-search')}<input type="search" placeholder="Filter records" data-role-table-search></label>
          <button class="outline-button role-export" data-role-action="export">${icon('i-download')} Export</button>
        </div>
      </div>
      <div class="role-status-tabs" data-role-tabs>
        <button class="active" data-role-filter="all">All</button><button data-role-filter="good">Active</button><button data-role-filter="warn">Needs attention</button><button data-role-filter="bad">Critical</button>
      </div>
      <div class="role-table-wrap"><table class="role-table"><thead><tr>${data.columns.map(column => `<th>${esc(column)}</th>`).join('')}<th>Action</th></tr></thead>
      <tbody>${data.rows.map((row, rowIndex) => {
        const state = statusClass(row[row.length - 1]);
        return `<tr data-row-state="${state}">${row.map((cell, cellIndex) => `<td data-label="${esc(data.columns[cellIndex] || 'Value')}">${cellIndex === row.length - 1 ? `<span class="role-status ${state}">${esc(cell)}</span>` : `<span>${esc(cell)}</span>`}</td>`).join('')}<td data-label="Action"><button class="role-row-menu" data-role-action="open-record" data-record="${esc(row[0])}" aria-label="Open ${esc(row[0])}">•••</button></td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="role-table-footer"><span>Showing ${data.rows.length} priority records</span><div><button disabled>Previous</button><button class="active">1</button><button data-role-action="next-page">2</button><button data-role-action="next-page">Next</button></div></div>
    </section>`;
  }

  function insightsMarkup(page, data) {
    return `<aside class="role-side-stack">
      <section class="panel role-insights"><div class="role-panel-head compact"><div><span class="eyebrow">Decision support</span><h2>What needs attention</h2></div></div>
        <div class="role-insight-list">${data.insights.map((text,index) => `<article><span>${index + 1}</span><p>${esc(text)}</p></article>`).join('')}</div>
        <button class="soft-button full-button" data-role-action="review-insights">Review recommendations</button>
      </section>
      <section class="panel role-progress-card"><div class="role-panel-head compact"><div><span class="eyebrow">Performance</span><h2>Workspace health</h2></div><strong>92%</strong></div>
        <div class="role-health-ring"><span>92<small>%</small></span></div>
        <div class="role-health-rows"><div><span>Data quality</span><b>96%</b></div><div><span>Response target</span><b>91%</b></div><div><span>Task completion</span><b>89%</b></div></div>
      </section>
    </aside>`;
  }

  function activityMarkup(page, data) {
    return `<section class="panel role-activity-panel"><div class="role-panel-head"><div><h2>Workflow & recent activity</h2><p>Keep the team aligned on the next operational actions.</p></div><button class="plain-link" data-role-action="view-all">View all activity</button></div>
      <div class="role-workflow-grid">
        ${data.insights.map((text,index) => `<article><span class="role-step ${index === 0 ? 'current' : ''}">${index + 1}</span><div><strong>${['Review priority queue','Complete assigned actions','Confirm outcome'][index] || 'Follow up'}</strong><p>${esc(text)}</p></div><button data-role-action="workflow">${index === 2 ? 'Open' : 'Continue'}</button></article>`).join('')}
      </div></section>`;
  }

  function chartMarkup(role) {
    const labels = role === 'promoter' ? ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] : ['Mar','Apr','May','Jun','Jul','Aug','Sep'];
    const values = role === 'seller' ? [45,58,52,68,64,82,91] : role === 'promoter' ? [38,54,49,66,73,86,79] : [42,49,57,62,70,78,88];
    return `<section class="panel role-chart-panel"><div class="role-panel-head"><div><h2>Performance trend</h2><p>Compared with the previous equivalent period.</p></div><select aria-label="Chart period"><option>Last 7 months</option><option>Last 30 days</option><option>This year</option></select></div>
      <div class="role-chart" aria-label="Performance bar chart">${values.map((value,index) => `<div><span style="height:${value}%"><b>${value}</b></span><small>${labels[index]}</small></div>`).join('')}</div>
      <div class="role-chart-legend"><span><i></i> Current period</span><strong>+18.4% overall growth</strong></div></section>`;
  }

  function overviewMarkup(role, page) {
    const data = overviewByRole[role];
    const profile = roleProfiles[role];
    return `<section class="app-page role-page" data-page="${page[0]}" data-role="${role}" data-page-kind="overview">
      <div class="page-heading role-page-heading"><div><span class="eyebrow">${esc(page[3])}</span><h1>${esc(page[4])}</h1><p>${esc(page[5])}</p></div><button class="primary-button icon-button" data-role-action="create" data-create-kind="overview" data-create-page="${page[0]}">${icon('i-plus')} Create task</button></div>
      <section class="role-welcome panel"><div><span class="eyebrow">${esc(profile.label)} workspace</span><h2>Good day, ${esc(profile.shortName)}.</h2><p>Your most important marketplace numbers and actions are ready.</p><div><button class="primary-button" data-role-action="primary-task">Open priority queue</button><button class="outline-button" data-role-action="download-summary">Download summary</button></div></div><div class="role-welcome-score"><small>Workspace score</small><strong>92</strong><span>Excellent</span></div></section>
      ${metricCards(data.stats)}
      <div class="role-overview-grid">${chartMarkup(role)}<section class="panel role-focus-panel"><div class="role-panel-head compact"><div><span class="eyebrow">Today</span><h2>Priority actions</h2></div><strong>${data.focus.length}</strong></div><div class="role-focus-list">${data.focus.map((item,index) => `<button data-role-action="priority"><span>${index + 1}</span><p>${esc(item)}</p>${icon('i-chevron-right')}</button>`).join('')}</div></section></div>
      <div class="role-bottom-grid"><section class="panel role-activity-feed"><div class="role-panel-head"><div><h2>Marketplace activity</h2><p>Important changes in your workspace.</p></div><button class="plain-link" data-role-action="view-all">View all</button></div>${data.activity.map((item,index) => `<article><span class="tone-${index + 1}">${icon(['i-award','i-wallet','i-bell'][index])}</span><div><strong>${esc(item)}</strong><small>${['12 minutes ago','1 hour ago','Today at 08:30'][index]}</small></div></article>`).join('')}</section><section class="panel role-team-panel"><div class="role-panel-head"><div><h2>Team coverage</h2><p>Currently active in this workspace.</p></div><span class="role-live"><i></i> Live</span></div><div class="role-avatar-stack"><span>GN</span><span>JK</span><span>LA</span><span>PO</span><b>+12</b></div><div class="role-team-stats"><div><small>Online</small><strong>16</strong></div><div><small>Assigned tasks</small><strong>42</strong></div><div><small>Completed</small><strong>31</strong></div></div><button class="soft-button full-button" data-role-action="team">Open team workspace</button></section></div>
    </section>`;
  }

  function productFormMarkup(page, role) {
    return `<section class="app-page role-page" data-page="${page[0]}" data-role="${role}">
      <div class="page-heading role-page-heading"><div><span class="eyebrow">${esc(page[3])}</span><h1>${esc(page[4])}</h1><p>${esc(page[5])}</p></div><button class="outline-button icon-button" data-page-target="seller-products">${icon('i-box')} View products</button></div>
      <form class="role-editor" data-role-form>
        <div class="role-editor-main">
          <section class="panel role-form-section"><div class="role-panel-head compact"><div><span class="role-section-number">1</span><h2>Basic product information</h2></div><span class="role-required">Required</span></div><div class="role-form-grid"><label class="wide">Product name<input required placeholder="Example: Classic wireless headphones"></label><label>Category<select required><option value="">Choose category</option><option>Electronics</option><option>Fashion</option><option>Home & Living</option></select></label><label>Brand<input required placeholder="Brand name"></label><label class="wide">Product description<textarea required rows="5" placeholder="Describe materials, features, benefits, and what is included."></textarea></label></div></section>
          <section class="panel role-form-section"><div class="role-panel-head compact"><div><span class="role-section-number">2</span><h2>Pricing and inventory</h2></div></div><div class="role-form-grid"><label>Selling price<input required type="number" min="0" placeholder="UGX"></label><label>Compare-at price<input type="number" min="0" placeholder="UGX"></label><label>SKU<input required placeholder="SKU-001"></label><label>Available stock<input required type="number" min="0" placeholder="0"></label></div></section>
          <section class="panel role-form-section"><div class="role-panel-head compact"><div><span class="role-section-number">3</span><h2>Media and delivery</h2></div></div><div class="role-upload-box"><span>${icon('i-plus')}</span><strong>Add clear product images</strong><p>Use square JPG, PNG, or WebP images. The first image becomes the cover.</p><button type="button" class="soft-button" data-role-action="upload">Choose files</button></div><div class="role-form-grid"><label>Package weight<input type="number" min="0" placeholder="kg"></label><label>Processing time<select><option>Same day</option><option>1 business day</option><option>2 business days</option></select></label></div></section>
        </div>
        <aside class="role-editor-side"><section class="panel role-publish-card"><span class="eyebrow">Publishing</span><h2>Listing readiness</h2><div class="role-readiness"><strong>72%</strong><span><i style="width:72%"></i></span></div><label>Status<select><option>Draft</option><option>Submit for review</option></select></label><button class="primary-button full-button" type="submit">Save Product</button><button class="outline-button full-button" type="button" data-role-action="preview">Preview Listing</button></section><section class="panel role-tip-card"><span>${icon('i-award')}</span><div><strong>Improve conversion</strong><p>Listings with five clear images and complete attributes convert better.</p></div></section></aside>
      </form>
    </section>`;
  }

  function settingsFormMarkup(page, role) {
    const profile = roleProfiles[role];
    const storeMode = page[6] === 'settings-store';
    const promoterMode = page[6] === 'settings-promoter';
    const financialMode = ['seller','promoter','finance','business'].includes(role);
    const secondLabel = storeMode ? 'Business details' : promoterMode ? 'Channels & audience' : role === 'business' ? 'Company details' : 'Workspace details';
    const secondTitle = storeMode ? 'Business & fulfilment' : promoterMode ? 'Channels & audience' : role === 'business' ? 'Company purchasing profile' : 'Workspace & operating preferences';
    const entityLabel = storeMode ? 'Store name' : role === 'business' ? 'Company name' : role === 'support' ? 'Support team name' : role === 'warehouse' ? 'Warehouse name' : role === 'moderator' ? 'Trust team name' : role === 'finance' ? 'Finance team name' : role === 'admin' ? 'Admin team name' : role === 'superadmin' ? 'Platform workspace name' : 'Display name';
    const aboutText = storeMode ? 'Trusted Classic Mart store offering quality products and reliable fulfilment.' : promoterMode ? 'Promoter creating useful product content for an engaged audience.' : `${profile.label} workspace configured for secure, efficient Classic Mart operations.`;
    const secondaryFields = storeMode
      ? `<label>Primary category<select><option>Fashion</option><option>Electronics</option><option>Home & Living</option></select></label><label>Registration number<input value="CM-UG-28420"></label><label>Tax number<input value="TIN-10488291"></label><label>Pickup city<input value="Kampala"></label>`
      : promoterMode
        ? `<label>Primary channel<select><option>TikTok</option><option>Instagram</option><option>YouTube</option><option>WhatsApp</option></select></label><label>Audience size<input value="84,000"></label><label>Audience location<input value="Kampala"></label><label>Content category<select><option>Technology</option><option>Fashion</option><option>Home & Living</option></select></label>`
        : role === 'business'
          ? `<label>Procurement category<select><option>General procurement</option><option>Technology</option><option>Office & operations</option></select></label><label>Registration number<input value="CM-BIZ-28420"></label><label>Approval threshold<input value="UGX 2,000,000"></label><label>Primary delivery city<input value="Kampala"></label>`
          : `<label>Default queue / area<input value="${esc(page[4].replace(' Settings',''))}"></label><label>Operating region<select><option>Uganda</option><option>Kenya</option><option>Platform-wide</option></select></label><label>Coverage window<select><option>Business hours</option><option>Extended hours</option><option>24 / 7</option></select></label><label>Escalation level<select><option>Standard</option><option>Manager review</option><option>High-risk approval</option></select></label>`;
    const thirdPanel = financialMode
      ? `<form class="panel form-panel role-settings-panel" data-role-settings-panel="payments" data-role-form><h2>${role === 'business' ? 'Company payment settings' : 'Payment & payout settings'}</h2><p class="form-intro">Manage verified payment destinations and finance preferences without exposing sensitive credentials.</p><div class="role-payment-method"><span>${icon('i-card')}</span><div><strong>${role === 'business' ? 'Stanbic Business •••• 9421' : 'Stanbic Bank •••• 9421'}</strong><small>Primary method · Verified</small></div><button type="button" class="soft-button" data-role-action="edit-payment">Edit</button></div><button class="outline-button" type="button" data-role-action="add-payment">Add another method</button></form>`
      : `<form class="panel form-panel role-settings-panel" data-role-settings-panel="payments" data-role-form><h2>Workspace controls</h2><p class="form-intro">Set sensible defaults for this operational workspace.</p><div class="role-form-grid"><label>Default landing view<select><option>Overview</option><option>Priority queue</option><option>Recent activity</option></select></label><label>Default density<select><option>Comfortable</option><option>Compact</option></select></label><label>Session idle reminder<select><option>15 minutes</option><option>30 minutes</option><option>60 minutes</option></select></label><label>Timezone<select><option>Africa/Kampala</option><option>Africa/Nairobi</option><option>UTC</option></select></label></div><button class="primary-button" type="submit">Save workspace controls</button></form>`;

    const profileTabLabel = storeMode ? 'Store profile' : role === 'business' ? 'Company profile' : 'Personal information';
    const profileBadgeIcon = storeMode || role === 'business' ? 'i-bag' : role === 'promoter' ? 'i-award' : 'i-shield';
    return `<section class="app-page role-page" data-page="${page[0]}" data-role="${role}">
      <div class="page-heading role-page-heading"><div><span class="eyebrow">Account preferences</span><h1>${esc(page[4])}</h1><p>${esc(page[5])}</p></div><button class="outline-button icon-button" data-role-action="security">${icon('i-shield')} Security centre</button></div>
      <div class="profile-layout role-settings-layout role-profile-settings">
        <aside class="panel profile-summary role-profile-summary">
          <div class="profile-avatar-wrap role-profile-avatar-wrap"><span class="role-profile-avatar">${esc(profile.shortName.slice(0,2).toUpperCase())}</span><button type="button" data-role-action="change-photo" aria-label="Change profile image">${icon('i-edit')}</button></div>
          <h2>${esc(profile.name)}</h2><p>hello@classicmart.example</p>
          <span class="member-pill">${icon(profileBadgeIcon)} ${esc(profile.label)}</span>
          <div class="profile-completion"><div><span>Profile completion</span><strong>92%</strong></div><div><span style="width:92%"></span></div></div>
          <nav class="settings-nav role-settings-nav" aria-label="Profile settings sections">
            <button class="active" data-role-settings-tab="profile">${profileTabLabel}</button>
            <button data-role-settings-tab="business">${secondLabel}</button>
            <button data-role-settings-tab="payments">${financialMode ? 'Payments' : 'Workspace preferences'}</button>
            <button data-role-settings-tab="notifications">Communication</button>
            <button data-role-settings-tab="security">Password &amp; Security</button>
          </nav>
        </aside>
        <div class="role-settings-content">
          <form class="panel form-panel role-settings-panel active" data-role-settings-panel="profile" data-role-form><div class="section-heading"><div><h2>${storeMode ? 'Store identity' : role === 'business' ? 'Company identity' : 'Personal Information'}</h2><p class="form-intro">Keep the information shown across Classic Mart accurate and consistent.</p></div><span class="verified-label">${icon('i-check')} Verified</span></div><div class="role-form-grid"><label>${entityLabel}<input value="${esc(profile.name)}" required></label><label>Contact email<input type="email" value="hello@classicmart.example" required></label><label>Phone number<input value="+256 781 977 217"></label><label>Country<select><option>Uganda</option><option>Kenya</option><option>South Sudan</option></select></label><label class="wide">About<textarea rows="5">${esc(aboutText)}</textarea></label></div><button class="primary-button" type="submit">Save Changes</button></form>
          <form class="panel form-panel role-settings-panel" data-role-settings-panel="business" data-role-form><h2>${secondTitle}</h2><p class="form-intro">These settings keep the workspace aligned with its real operating responsibility.</p><div class="role-form-grid">${secondaryFields}</div><button class="primary-button" type="submit">Save Changes</button></form>
          ${thirdPanel}
          <form class="panel form-panel role-settings-panel" data-role-settings-panel="notifications" data-role-form><h2>Communication Preferences</h2><p class="form-intro">Choose which operational updates should reach this account.</p><div class="role-toggle-list"><label><div><strong>Priority work</strong><small>Important transaction, queue, or approval updates</small></div><span class="switch"><input type="checkbox" checked><span></span></span></label><label><div><strong>Escalations</strong><small>Items that require higher-risk or manager attention</small></div><span class="switch"><input type="checkbox" checked><span></span></span></label><label><div><strong>Weekly performance report</strong><small>Workspace summary delivered by email</small></div><span class="switch"><input type="checkbox"><span></span></span></label></div><button class="primary-button" type="submit">Save Preferences</button></form>
          <form class="panel form-panel role-settings-panel" data-role-settings-panel="security" data-role-form><h2>Password &amp; Security</h2><p class="form-intro">Protect the account and review signed-in sessions.</p><div class="role-security-row"><span>${icon('i-shield')}</span><div><strong>Two-factor authentication</strong><small>Protect this account with an additional verification step.</small></div><button type="button" class="soft-button" data-role-action="enable-mfa">Enable</button></div><div class="role-security-row"><span>${icon('i-eye')}</span><div><strong>Active sessions</strong><small>3 signed-in devices · Last checked today</small></div><button type="button" class="outline-button" data-role-action="sessions">Review</button></div></form>
        </div>
      </div>
    </section>`;
  }

  function actionLabelFor(kind, role) {
    const labels = {
      users: 'Invite user', roles: 'Create role', admins: 'Add admin', sellers: 'Invite seller', promoters: 'Invite promoter', customers: 'Add customer',
      approvals: 'Start review', products: 'Add product', categories: 'Add category', orders: role === 'business' ? 'Create purchase order' : 'Create order',
      returns: 'Create return', finance: 'Record finance case', commissions: 'Create rule', subscriptions: 'Create plan', disputes: 'Open case', reports: 'Create report',
      audit: 'Create audit export', security: 'Open incident', notifications: 'New communication', support: 'Create ticket', inventory: 'Record stock movement',
      shipping: 'Create dispatch', campaigns: 'Create campaign', 'campaigns-market': 'Apply to campaign', coupons: 'Create coupon', reviews: 'Open review case', content: 'Create content', payouts: 'Request payout',
      analytics: 'Create analysis', messages: 'New message', links: 'Create link', traffic: 'Create tracking view', conversions: 'Record conversion note', referrals: 'Add referral', brands: 'Add partnership'
    };
    return labels[kind] || 'Create record';
  }

  function standardPageMarkup(role, page) {
    if (page[6] === 'form-product') return productFormMarkup(page, role);
    if (settingsPresets.has(page[6])) return settingsFormMarkup(page, role);
    const data = presetFor(page);
    const actionLabel = actionLabelFor(page[6], role);
    return `<section class="app-page role-page" data-page="${page[0]}" data-role="${role}" data-page-kind="${page[6]}">
      <div class="page-heading role-page-heading"><div><span class="eyebrow">${esc(page[3])}</span><h1>${esc(page[4])}</h1><p>${esc(page[5])}</p></div><button class="primary-button icon-button" data-role-action="create" data-create-kind="${page[6]}" data-create-page="${page[0]}">${icon('i-plus')} ${esc(actionLabel)}</button></div>
      ${metricCards(data.stats)}
      ${page[6] === 'analytics' || page[6] === 'traffic' ? `<div class="role-analytics-top">${chartMarkup(role)}${insightsMarkup(page,data)}</div>` : `<div class="role-content-grid">${tableMarkup(page,data)}${insightsMarkup(page,data)}</div>`}
      ${activityMarkup(page,data)}
    </section>`;
  }

  function buildRolePages() {
    const host = document.getElementById('pageHost');
    if (!host || host.querySelector('.role-page')) return;
    const markup = Object.entries(rolePages).flatMap(([role,pages]) => pages.map(page => page[6] === 'overview' ? overviewMarkup(role,page) : standardPageMarkup(role,page))).join('');
    host.insertAdjacentHTML('beforeend', markup);
  }

  function buildWorkspaceLabel() {
    const topActions = document.querySelector('.top-actions');
    if (!topActions || document.getElementById('workspaceLabel')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'workspace-switcher';
    wrapper.id = 'workspaceLabel';
    wrapper.innerHTML = `${icon('i-dashboard')}<span class="workspace-name"></span>`;
    topActions.insertBefore(wrapper, topActions.firstChild);
  }

  function navMarkup(role) {
    let lastGroup = '';
    return rolePages[role].map(page => {
      const group = page[3];
      const groupMarkup = group !== lastGroup ? `<span class="nav-section-label">${esc(group)}</span>` : '';
      lastGroup = group;
      return `${groupMarkup}<a class="side-link" href="#${page[0]}" data-page-target="${page[0]}">${icon(page[2])}<span>${esc(page[1])}</span></a>`;
    }).join('');
  }

  function sidebarCard(role) {
    const cards = {
      superadmin: ['Platform control','99.98% system availability','2 low-risk alerts','super-security','Review System'],
      admin: ['Operations health','94.2% customer satisfaction','36 order exceptions','admin-orders','Open Queue'],
      seller: ['Store health','96% store quality score','14 low-stock products','seller-inventory','Improve Store'],
      promoter: ['This month','UGX 4.8M commission','12 active campaigns','promoter-analytics','View Performance'],
      finance: ['Finance controls','99.7% reconciled','3 exceptions','finance-reconciliation','Reconcile Now'],
      support: ['Service health','94.2% customer satisfaction','14 escalations','support-queue','Open Queue'],
      warehouse: ['Fulfilment health','99.4% inventory accuracy','7 exceptions','warehouse-dispatch','Open Dispatch'],
      moderator: ['Trust health','97.1% decision quality','7 high-risk cases','moderator-products','Review Queue'],
      business: ['Company buying','UGX 42.6M monthly spend','4 approvals pending','business-orders','Review Orders']
    };
    const item = cards[role];
    return `<span class="sidebar-crown">${icon(role === 'seller' ? 'i-bag' : role === 'promoter' ? 'i-award' : 'i-shield')}</span><h3>${item[0]}</h3><p class="member-copy">${item[1]}</p><p>${item[2]}</p><button class="primary-button full-button" data-page-target="${item[3]}">${item[4]}</button>`;
  }

  function updateHeader(role) {
    const profile = roleProfiles[role];
    const profileButton = document.getElementById('profileButton');
    if (profileButton) {
      const strong = profileButton.querySelector('strong');
      const small = profileButton.querySelector('small');
      const image = profileButton.querySelector('img');
      if (strong) strong.textContent = `Hi, ${profile.shortName}`;
      if (small) small.textContent = profile.label;
      if (image) image.alt = profile.name;
    }
    const search = document.getElementById('searchInput');
    if (search) search.placeholder = profile.search;
    const quick = document.querySelector('.categories-button');
    if (quick) {
      quick.dataset.pageTarget = profile.quickPage;
      const label = quick.querySelector('span');
      if (label) label.textContent = profile.quickLabel;
    }
    const workspaceName = document.querySelector('#workspaceLabel .workspace-name');
    if (workspaceName) workspaceName.textContent = `${profile.label} Dashboard`;
    const brand = document.querySelector('.brand');
    if (brand) {
      brand.dataset.pageTarget = profile.defaultPage;
      brand.setAttribute('href', `#${profile.defaultPage}`);
    }
    const notificationPages = { customer: 'notifications', superadmin: 'super-notifications', admin: 'admin-support', seller: 'seller-messages', promoter: 'promoter-messages', finance: 'finance-reconciliation', support: 'support-queue', warehouse: 'warehouse-dispatch', moderator: 'moderator-products', business: 'business-orders' };
    const notificationButton = document.querySelector('.badge-button[aria-label="Notifications"]');
    if (notificationButton) notificationButton.dataset.pageTarget = notificationPages[role];
    const customerOnly = document.querySelectorAll('.badge-button[data-page-target="wishlist"], .badge-button[data-page-target="cart"]');
    customerOnly.forEach(element => { element.hidden = role !== 'customer'; });

    const profileMenuButtons = document.querySelectorAll('#profileMenu [data-page-target]');
    profileMenuButtons.forEach((button,index) => {
      if (role === 'customer') {
        button.dataset.pageTarget = 'profile';
        if (index === 1) button.dataset.profileTab = 'security';
      } else {
        const settingsPages = { seller: 'seller-store', promoter: 'promoter-profile', admin: 'admin-settings', superadmin: 'super-settings', finance: 'finance-settings', support: 'support-settings', warehouse: 'warehouse-settings', moderator: 'moderator-settings', business: 'business-settings' };
        const settingsPage = settingsPages[role] || 'super-settings';
        button.dataset.pageTarget = settingsPage;
        delete button.dataset.profileTab;
      }
    });
  }

  function applyRole(role, options = {}) {
    if (!roleProfiles[role]) role = 'customer';
    currentRole = role;
    document.body.dataset.workspace = role;
    const nav = document.querySelector('.side-navigation');
    const card = document.querySelector('.sidebar-club-card');
    const sidebar = document.getElementById('sidebar');
    if (nav) nav.innerHTML = role === 'customer' ? customerNavMarkup : navMarkup(role);
    if (card) card.innerHTML = role === 'customer' ? customerSidebarCardMarkup : sidebarCard(role);
    if (sidebar) sidebar.scrollTop = 0;
    updateHeader(role);
    storeRole(role);
    if (options.navigate !== false && typeof window.navigateTo === 'function') window.navigateTo(roleProfiles[role].defaultPage);
  }

  function roleForPage(pageId) {
    if (!pageId) return null;
    for (const [role,pages] of Object.entries(rolePages)) {
      if (pages.some(page => page[0] === pageId)) return role;
    }
    return null;
  }

  function ensureRoleForPage(pageId) {
    const role = roleForPage(pageId);
    if (role && role !== currentRole) applyRole(role, { navigate: false });
    if (!role && document.querySelector(`.app-page[data-page="${pageId}"]`) && currentRole !== 'customer') applyRole('customer', { navigate: false });
  }

  function searchWorkspace(query) {
    if (currentRole === 'customer') return false;
    const activePage = document.querySelector('.app-page.active');
    const input = activePage?.querySelector('[data-role-table-search]');
    if (input) {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.showToast?.(`Filtered ${roleProfiles[currentRole].label} records for “${query}”`);
    } else {
      window.navigateTo?.(roleProfiles[currentRole].defaultPage);
      window.showToast?.(`Workspace search ready for “${query}”`);
    }
    return true;
  }

  function setSettingsTab(button) {
    const layout = button.closest('.role-settings-layout');
    if (!layout) return;
    const tab = button.dataset.roleSettingsTab;
    layout.querySelectorAll('[data-role-settings-tab]').forEach(item => item.classList.toggle('active', item === button));
    layout.querySelectorAll('[data-role-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.roleSettingsPanel === tab));
  }

  function filterRoleTable(input) {
    const panel = input.closest('.role-table-panel');
    const query = input.value.trim().toLowerCase();
    panel?.querySelectorAll('tbody tr').forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  }

  function filterByState(button) {
    const panel = button.closest('.role-table-panel');
    const state = button.dataset.roleFilter;
    panel?.querySelectorAll('[data-role-filter]').forEach(item => item.classList.toggle('active', item === button));
    panel?.querySelectorAll('tbody tr').forEach(row => { row.hidden = state !== 'all' && row.dataset.rowState !== state; });
  }

  const createFormConfigs = {
    overview: { title: 'Create priority task', submit: 'Create task', note: 'Create a workspace task with a clear owner, priority, and due date.', fields: [
      ['Task title','title','text','Example: Review payout exceptions',true,'wide'], ['Owner / team','owner','text','Operations team',true], ['Priority','priority','select',['Normal','High','Urgent'],true], ['Due date','due','date','',false], ['Notes','notes','textarea','Add context, acceptance criteria, or a handoff note.',false,'wide'] ] },
    analytics: { title: 'Create analysis view', submit: 'Create analysis', note: 'Saved analysis views should have a clear metric, comparison period, and business question.', fields: [
      ['Analysis name','name','text','Marketplace conversion review',true,'wide'], ['Primary metric','metric','select',['GMV','Orders','Conversion rate','Retention','Fulfilment SLA'],true], ['Period','period','select',['Last 7 days','Last 30 days','Quarter to date','Year to date'],true], ['Compare with','compare','select',['Previous period','Previous year','No comparison'],false], ['Business question','question','textarea','What decision should this analysis help answer?',true,'wide'] ] },
    traffic: { title: 'Create tracking view', submit: 'Save tracking view', note: 'Use named tracking views to keep acquisition and conversion analysis repeatable.', fields: [
      ['View name','name','text','Campaign traffic quality',true,'wide'], ['Channel','channel','select',['All channels','Search','Social','WhatsApp','Direct','Referral'],true], ['Period','period','select',['Last 7 days','Last 30 days','This quarter'],true], ['Goal','goal','text','Example: Product purchase',false], ['Notes','notes','textarea','Optional measurement notes.',false,'wide'] ] },
    users: { title: 'Invite a user', submit: 'Send invite', note: 'Invited users should receive only the minimum access required for their responsibility.', fields: [
      ['Full name','name','text','Full name',true], ['Email address','email','email','name@example.com',true], ['Account type','type','select',['Customer','Seller','Promoter','Staff'],true], ['Country','country','select',['Uganda','Kenya','South Sudan'],true], ['Reason / note','notes','textarea','Why is this account being created?',false,'wide'] ] },
    customers: { title: 'Add customer record', submit: 'Create customer', note: 'Use this only for assisted onboarding where consent and identity details are available.', fields: [
      ['Full name','name','text','Customer name',true], ['Email','email','email','customer@example.com',false], ['Phone','phone','tel','+256...',true], ['Country','country','select',['Uganda','Kenya','South Sudan'],true], ['Onboarding note','notes','textarea','Optional assisted-onboarding context.',false,'wide'] ] },
    admins: { title: 'Add administrator', submit: 'Create admin invite', note: 'Administrative access should be role-scoped, reviewed, and protected with MFA.', fields: [
      ['Full name','name','text','Administrator name',true], ['Work email','email','email','admin@classicmart.example',true], ['Department','department','select',['Operations','Finance','Support','Trust & Safety','Content','Warehouse'],true], ['Access profile','access','select',['Read only','Operator','Manager','Administrator'],true], ['Access reason','reason','textarea','Business reason for granting access.',true,'wide'] ] },
    roles: { title: 'Create role', submit: 'Create role', note: 'Keep permissions least-privileged. High-risk capabilities should require approval and audit evidence.', fields: [
      ['Role name','name','text','Example: Returns Supervisor',true,'wide'], ['Workspace','workspace','select',['Operations','Finance','Support','Trust & Safety','Warehouse','Content'],true], ['Scope','scope','select',['Country','Department','Assigned records','Platform-wide'],true], ['Approval level','approval','select',['Standard','Manager approval','Four-eyes approval'],true], ['Role description','description','textarea','Describe responsibilities and limits.',true,'wide'] ] },
    sellers: { title: 'Invite seller', submit: 'Send seller invite', note: 'Seller activation should follow business verification and catalogue readiness checks.', fields: [
      ['Business name','business','text','Business / store name',true], ['Contact person','contact','text','Primary contact',true], ['Email','email','email','seller@example.com',true], ['Phone','phone','tel','+256...',true], ['Primary category','category','select',['Fashion','Electronics','Home & Living','Beauty','Sports'],true], ['Country','country','select',['Uganda','Kenya','South Sudan'],true], ['Invitation note','notes','textarea','Optional onboarding instructions.',false,'wide'] ] },
    promoters: { title: 'Invite promoter', submit: 'Send promoter invite', note: 'Promoter onboarding should capture channel ownership and programme eligibility.', fields: [
      ['Display / business name','name','text','Promoter name',true], ['Email','email','email','promoter@example.com',true], ['Phone','phone','tel','+256...',true], ['Primary channel','channel','select',['TikTok','Instagram','YouTube','WhatsApp','Facebook','Website'],true], ['Audience location','location','text','Kampala, Uganda',false], ['Note','notes','textarea','Optional campaign or onboarding context.',false,'wide'] ] },
    approvals: { title: 'Start approval review', submit: 'Create review', note: 'A review should identify the applicant, scope, evidence required, and decision owner.', fields: [
      ['Applicant / record','record','text','Name or reference',true,'wide'], ['Review type','type','select',['Seller verification','Promoter verification','Document update','Policy exception'],true], ['Risk level','risk','select',['Low','Medium','High'],true], ['Reviewer','reviewer','text','Assigned reviewer',false], ['Evidence required','evidence','textarea','List the evidence or checks needed before a decision.',true,'wide'] ] },
    products: { title: 'Add product record', submit: 'Create draft product', note: 'Create a draft first, then complete media, attributes, inventory, and moderation before publishing.', fields: [
      ['Product name','name','text','Product name',true,'wide'], ['Seller','seller','text','Seller / store',true], ['Category','category','select',['Fashion','Electronics','Home & Living','Beauty','Sports'],true], ['Selling price','price','number','UGX',true], ['SKU','sku','text','SKU-001',true], ['Opening stock','stock','number','0',false], ['Description','description','textarea','Short product description.',false,'wide'] ] },
    categories: { title: 'Add category', submit: 'Create category', note: 'Category changes affect discovery, attributes, fees, and catalogue governance.', fields: [
      ['Category name','name','text','Category name',true], ['Parent category','parent','text','Leave blank for top level',false], ['Default commission %','commission','number','3',false], ['Visibility','visibility','select',['Visible','Hidden','Draft'],true], ['Required attributes','attributes','textarea','Example: Brand, size, colour, material',false,'wide'] ] },
    orders: { title: 'Create order', submit: 'Create draft order', note: 'Manual orders should preserve customer consent, item pricing, stock checks, payment state, and audit history.', fields: [
      ['Customer / company','customer','text','Customer or company name',true], ['Product / SKU','product','text','Product name or SKU',true], ['Quantity','quantity','number','1',true], ['Order value','amount','number','UGX',true], ['Delivery method','delivery','select',['Standard delivery','Pickup','Express delivery'],true], ['Internal note','notes','textarea','Optional order context.',false,'wide'] ] },
    returns: { title: 'Create return case', submit: 'Create return', note: 'Return eligibility should use the policy snapshot attached to the original purchase.', fields: [
      ['Order number','order','text','CM-...',true], ['Item / SKU','item','text','Product or SKU',true], ['Reason','reason','select',['Damaged item','Wrong item','Not as described','Size / fit','Changed mind','Other'],true], ['Preferred resolution','resolution','select',['Refund','Exchange','Replacement','Store credit'],true], ['Customer details / evidence','notes','textarea','Describe the issue and any evidence received.',true,'wide'] ] },
    finance: { title: 'Record finance case', submit: 'Create finance case', note: 'This standalone form records a review case only; it does not move money or bypass approval controls.', fields: [
      ['Reference','reference','text','Order, payment, settlement, or payout ID',true,'wide'], ['Case type','type','select',['Payment exception','Settlement review','Fee review','Provider mismatch','Manual investigation'],true], ['Amount','amount','number','UGX',false], ['Priority','priority','select',['Normal','High','Urgent'],true], ['Reason and evidence','notes','textarea','Record why this case needs finance review.',true,'wide'] ] },
    commissions: { title: 'Create commission rule', submit: 'Create draft rule', note: 'Rates should be effective-dated and approved before they affect real marketplace earnings.', fields: [
      ['Rule name','name','text','Example: Promoter base rate',true,'wide'], ['Applies to','applies','select',['Seller category','Promoter programme','Campaign','Country'],true], ['Rate %','rate','number','3',true], ['Starts on','start','date','',true], ['Ends on','end','date','',false], ['Conditions','conditions','textarea','Eligibility, exclusions, caps, or reversal rules.',false,'wide'] ] },
    subscriptions: { title: 'Create subscription plan', submit: 'Create draft plan', note: 'Plan pricing, benefits, eligibility, billing cadence, and cancellation rules should be explicit.', fields: [
      ['Plan name','name','text','Plan name',true], ['Audience','audience','select',['Seller','Promoter','Business'],true], ['Price','price','number','UGX',true], ['Billing','billing','select',['Monthly','Quarterly','Annual'],true], ['Benefits','benefits','textarea','Describe included benefits and limits.',true,'wide'] ] },
    disputes: { title: 'Open dispute / risk case', submit: 'Open case', note: 'Preserve evidence, parties, protected value, deadlines, and every decision in the case timeline.', fields: [
      ['Case title','title','text','Short issue summary',true,'wide'], ['Related order / record','record','text','CM-..., TX-..., seller, etc.',true], ['Case type','type','select',['Customer vs seller','Payment dispute','Attribution dispute','Policy appeal','Fraud / abuse'],true], ['Priority','priority','select',['Normal','High','Critical'],true], ['Protected value','value','number','UGX',false], ['Initial evidence / notes','notes','textarea','Describe the allegation and evidence already available.',true,'wide'] ] },
    reports: { title: 'Create report', submit: 'Save report', note: 'Saved reports inherit the active role scope and should expose only authorized data.', fields: [
      ['Report name','name','text','Report name',true,'wide'], ['Report type','type','select',['Operational summary','Finance detail','Orders','Catalogue','Support SLA','Trust & Safety'],true], ['Period','period','select',['Today','Last 7 days','Last 30 days','This month','Custom'],true], ['Format','format','select',['CSV','PDF','Spreadsheet'],true], ['Schedule','schedule','select',['Run now','Daily','Weekly','Monthly'],false], ['Description','notes','textarea','Optional description or filters.',false,'wide'] ] },
    audit: { title: 'Create audit export', submit: 'Prepare export', note: 'Audit exports should be permission-scoped, reasoned, time-bounded, and themselves audited.', fields: [
      ['Export reason','reason','text','Why is this audit data needed?',true,'wide'], ['Event type','type','select',['All privileged actions','Authentication','Configuration','Finance','Data export','Moderation'],true], ['From','from','date','',true], ['To','to','date','',true], ['Format','format','select',['CSV','PDF'],true], ['Case / approval reference','reference','text','Optional reference',false] ] },
    security: { title: 'Open security incident', submit: 'Create incident', note: 'Use incidents for investigation and coordination. Do not put passwords, secrets, or full payment credentials in notes.', fields: [
      ['Incident title','title','text','Short security issue',true,'wide'], ['Severity','severity','select',['Low','Medium','High','Critical'],true], ['Affected area','area','select',['Accounts','Payments','Infrastructure','Data','Integrations','Marketplace abuse'],true], ['Detected at','detected','datetime-local','',true], ['Owner','owner','text','Incident owner',false], ['Initial facts','notes','textarea','Known facts, impact, and immediate containment.',true,'wide'] ] },
    notifications: { title: 'Create communication', submit: 'Save communication', note: 'Target communications carefully and separate transactional notices from marketing consent.', fields: [
      ['Title','title','text','Notification title',true,'wide'], ['Audience','audience','select',['All customers','Sellers','Promoters','Business buyers','Specific country','Selected users'],true], ['Channel','channel','select',['In-app','Email','SMS','Push','Multiple channels'],true], ['Send time','send','select',['Save as draft','Send now','Schedule'],true], ['Message','message','textarea','Write the communication body.',true,'wide'] ] },
    support: { title: 'Create support ticket', submit: 'Create ticket', note: 'Capture the customer issue, related transaction, priority, ownership, and safe next action.', fields: [
      ['Customer / account','customer','text','Name, email, phone, or account ID',true], ['Related order','order','text','Optional CM-...',false], ['Category','category','select',['Order & Delivery','Payment & Wallet','Return & Refund','Account & Security','Seller / Promoter','Other'],true], ['Priority','priority','select',['Normal','High','Urgent'],true], ['Subject','subject','text','Short issue summary',true,'wide'], ['Message','message','textarea','Describe the issue and desired resolution.',true,'wide'] ] },
    inventory: { title: 'Record stock movement', submit: 'Record movement', note: 'Stock movements should always have a SKU, quantity, location, reason, and traceable reference.', fields: [
      ['Product / SKU','sku','text','SKU or product',true], ['Movement','movement','select',['Receive stock','Adjustment increase','Adjustment decrease','Damage','Transfer','Cycle count'],true], ['Quantity','quantity','number','0',true], ['Location','location','text','Warehouse / bin',true], ['Reference','reference','text','PO, order, count, or case ID',false], ['Reason / evidence','notes','textarea','Explain why this stock movement is required.',true,'wide'] ] },
    shipping: { title: 'Create dispatch', submit: 'Create dispatch', note: 'Courier handover should retain parcel identity, tracking, custody evidence, and dispatch time.', fields: [
      ['Order / parcel','order','text','Order or parcel reference',true], ['Courier','courier','text','Courier / driver / partner',true], ['Tracking number','tracking','text','Tracking reference',true], ['Dispatch time','time','datetime-local','',true], ['Service level','service','select',['Standard','Same day','Express','Pickup transfer'],true], ['Handover note','notes','textarea','Record package condition and custody details.',false,'wide'] ] },
    campaigns: { title: 'Create campaign', submit: 'Create campaign', note: 'Campaigns should have a clear objective, audience, dates, budget, and measurable outcome.', fields: [
      ['Campaign name','name','text','Campaign name',true,'wide'], ['Objective','objective','select',['Sales','New customers','Product launch','Seller activation','Promoter growth'],true], ['Audience','audience','text','Audience or segment',true], ['Budget','budget','number','UGX',false], ['Starts','start','date','',true], ['Ends','end','date','',true], ['Brief','brief','textarea','Campaign message, offer, products, and success metric.',true,'wide'] ] },
    'campaigns-market': { title: 'Apply to campaign', submit: 'Submit application', note: 'Campaign applications should match your verified channels, audience, and the seller campaign terms.', fields: [
      ['Campaign / product','campaign','text','Campaign or product name',true,'wide'], ['Primary channel','channel','select',['WhatsApp','TikTok','Instagram','YouTube','Facebook','Website'],true], ['Planned content','content','select',['Video','Short video','Post / carousel','Story / status','Article / review'],true], ['Expected publish date','publish','date','',false], ['Pitch / content idea','pitch','textarea','Explain how you would promote this campaign to your audience.',true,'wide'] ] },
    coupons: { title: 'Create coupon', submit: 'Create coupon', note: 'Coupon eligibility and budget limits should prevent accidental over-discounting.', fields: [
      ['Coupon code','code','text','CLASSIC10',true], ['Discount type','type','select',['Percentage','Fixed amount','Free delivery'],true], ['Value','value','number','10',true], ['Minimum order','minimum','number','UGX',false], ['Starts','start','date','',true], ['Ends','end','date','',true], ['Eligibility / limits','notes','textarea','Products, customers, countries, redemption caps, or exclusions.',false,'wide'] ] },
    reviews: { title: 'Open review case', submit: 'Create review case', note: 'Review moderation should preserve the original content and the reason for every action.', fields: [
      ['Review / product reference','reference','text','Review ID or product',true,'wide'], ['Issue','issue','select',['Spam','Manipulation','Abuse','Off-topic','Authenticity dispute','Appeal'],true], ['Priority','priority','select',['Normal','High','Critical'],true], ['Assigned reviewer','owner','text','Reviewer',false], ['Evidence / notes','notes','textarea','Describe the signal or complaint without altering original evidence.',true,'wide'] ] },
    content: { title: 'Create content', submit: 'Save draft', note: 'Content should be versioned, scheduled when needed, and reversible.', fields: [
      ['Content title','title','text','Title',true,'wide'], ['Placement','placement','select',['Homepage banner','Homepage section','Help article','Announcement','Legal / policy'],true], ['Audience','audience','select',['All','Uganda','Kenya','Sellers','Promoters','Customers'],true], ['Status','status','select',['Draft','Schedule','Publish'],true], ['Body / brief','body','textarea','Content text or creative brief.',true,'wide'] ] },
    payouts: { title: 'Request payout', submit: 'Submit payout request', note: 'Payout requests are subject to balance availability, approval, reconciliation, and provider confirmation.', fields: [
      ['Account / beneficiary','beneficiary','text','Seller or promoter',true], ['Amount','amount','number','UGX',true], ['Method','method','select',['Mobile money','Bank transfer'],true], ['Destination reference','destination','text','Masked account / phone reference',true], ['Reason / note','notes','textarea','Optional payout note.',false,'wide'] ] },
    messages: { title: 'New message', submit: 'Save message', note: 'Messages should stay within the permitted relationship and avoid exposing unnecessary personal data.', fields: [
      ['Recipient','recipient','text','Name, team, seller, or promoter',true], ['Subject','subject','text','Subject',true,'wide'], ['Message','message','textarea','Write your message.',true,'wide'] ] },
    links: { title: 'Create promoter link', submit: 'Create link', note: 'Attribution links should point to valid Classic Mart destinations and inherit the active promoter identity.', fields: [
      ['Link name','name','text','Example: September headphones push',true,'wide'], ['Destination','destination','text','Product, category, seller, or campaign',true], ['Campaign','campaign','text','Optional campaign',false], ['Channel','channel','select',['WhatsApp','TikTok','Instagram','YouTube','Facebook','Website'],true], ['Tracking note','notes','textarea','Optional content or audience note.',false,'wide'] ] },
    conversions: { title: 'Record conversion note', submit: 'Save note', note: 'Manual notes do not change authoritative attribution or commission state.', fields: [
      ['Order / conversion','reference','text','Order or conversion reference',true], ['Issue type','type','select',['Attribution question','Return follow-up','Commission review','Customer query'],true], ['Note','notes','textarea','Add context without changing authoritative transaction data.',true,'wide'] ] },
    referrals: { title: 'Add referral', submit: 'Send referral', note: 'Referral rewards should apply only after the referred account meets programme eligibility.', fields: [
      ['Name','name','text','Referral name',true], ['Email or phone','contact','text','Email or phone',true], ['Referral type','type','select',['Promoter','Seller','Business buyer'],true], ['Message','message','textarea','Optional invitation message.',false,'wide'] ] },
    brands: { title: 'Add partnership', submit: 'Create partnership record', note: 'Partnership records should capture the seller/brand, relationship owner, scope, and status.', fields: [
      ['Seller / brand','name','text','Seller or brand name',true], ['Category','category','text','Primary category',false], ['Relationship','relationship','select',['Invitation','Active collaboration','Preferred partner','Paused'],true], ['Owner','owner','text','Relationship owner',false], ['Notes','notes','textarea','Campaign or partnership context.',false,'wide'] ] },
    'payment-method': { title: 'Payment method', submit: 'Save payment method', note: 'This standalone demo stores no real card, bank, or mobile-money credentials. Production should tokenize or reference provider-held payment data.', fields: [
      ['Method type','type','select',['Mobile money','Bank account','Card'],true], ['Account label','label','text','Example: Primary business account',true], ['Provider / bank','provider','text','Provider or bank name',true], ['Masked reference','reference','text','Example: •••• 9421',true], ['Country','country','select',['Uganda','Kenya','South Sudan'],true], ['Note','notes','textarea','Optional settlement or payment preference.',false,'wide'] ] }
  };

  function genericCreateConfig(kind, pageTitle) {
    return createFormConfigs[kind] || { title: `Create ${pageTitle || 'record'}`, submit: 'Save record', note: 'Complete the required details before saving this standalone workspace record.', fields: [
      ['Name / reference','name','text','Enter a clear name or reference',true,'wide'], ['Status','status','select',['Draft','Active','Needs review'],true], ['Owner','owner','text','Assigned owner',false], ['Notes','notes','textarea','Add context or instructions.',false,'wide']
    ] };
  }

  function createFieldMarkup(field, index) {
    const [label,name,type,source,required,wide] = field;
    const id = `roleCreateField${index}`;
    const req = required ? ' required' : '';
    const cls = `role-create-field${wide === 'wide' ? ' wide' : ''}`;
    if (type === 'select') {
      return `<label class="${cls}" for="${id}">${esc(label)}${required ? ' *' : ''}<select id="${id}" name="${esc(name)}"${req}><option value="">Choose…</option>${source.map(option => `<option>${esc(option)}</option>`).join('')}</select></label>`;
    }
    if (type === 'textarea') {
      return `<label class="${cls}" for="${id}">${esc(label)}${required ? ' *' : ''}<textarea id="${id}" name="${esc(name)}" rows="4" placeholder="${esc(source || '')}"${req}></textarea></label>`;
    }
    return `<label class="${cls}" for="${id}">${esc(label)}${required ? ' *' : ''}<input id="${id}" name="${esc(name)}" type="${esc(type || 'text')}" placeholder="${esc(source || '')}"${type === 'number' ? ' min="0"' : ''}${req}></label>`;
  }

  function ensureCreateDialog() {
    let overlay = document.getElementById('roleCreateOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'roleCreateOverlay';
    overlay.className = 'role-create-overlay';
    overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML = `<section class="role-create-dialog" role="dialog" aria-modal="true" aria-labelledby="roleCreateTitle">
      <header class="role-create-head"><div><span class="eyebrow" id="roleCreateEyebrow">Create record</span><h2 id="roleCreateTitle">Create record</h2><p id="roleCreateSubtitle">Complete the form below.</p></div><button class="round-icon role-create-close" type="button" data-create-close aria-label="Close form">${icon('i-close')}</button></header>
      <div class="role-create-body"><form class="role-create-form" id="roleCreateForm"><div class="role-create-section">${icon('i-shield')}<span id="roleCreateNote"></span></div><div class="role-create-grid" id="roleCreateFields"></div><div class="role-create-actions"><button type="button" class="outline-button" data-create-close>Cancel</button><button type="submit" class="primary-button" id="roleCreateSubmit">Save</button></div></form></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => { if (event.target === overlay || event.target.closest('[data-create-close]')) closeCreateDialog(); });
    overlay.querySelector('#roleCreateForm').addEventListener('submit', event => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      const title = overlay.dataset.formTitle || 'Record';
      closeCreateDialog();
      window.showToast?.(`${title} saved in this standalone dashboard demo.`);
    });
    return overlay;
  }

  function openCreateDialog(target) {
    const activePage = target.closest('.role-page') || document.querySelector('.role-page.active');
    const kind = target.dataset.createKind || activePage?.dataset.pageKind || 'default';
    const pageTitle = target.dataset.createTitle || activePage?.querySelector('.page-heading h1')?.textContent?.trim() || 'record';
    const config = genericCreateConfig(kind, pageTitle);
    const overlay = ensureCreateDialog();
    overlay.dataset.formTitle = config.title;
    overlay.querySelector('#roleCreateEyebrow').textContent = `${roleProfiles[currentRole]?.label || 'Classic Mart'} · ${pageTitle}`;
    overlay.querySelector('#roleCreateTitle').textContent = config.title;
    overlay.querySelector('#roleCreateSubtitle').textContent = `Complete the required information for ${pageTitle.toLowerCase()}.`;
    overlay.querySelector('#roleCreateNote').textContent = config.note;
    overlay.querySelector('#roleCreateFields').innerHTML = config.fields.map(createFieldMarkup).join('');
    overlay.querySelector('#roleCreateSubmit').textContent = config.submit;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden','false');
    document.body.classList.add('role-dialog-open');
    requestAnimationFrame(() => overlay.querySelector('input, select, textarea')?.focus());
  }

  function closeCreateDialog() {
    const overlay = document.getElementById('roleCreateOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden','true');
    document.body.classList.remove('role-dialog-open');
  }

  function actionMessage(action, target) {
    const messages = {
      create: 'Creation workspace opened with a clean starter form.', export: 'The current workspace report was prepared for export.', 'open-record': `${target.dataset.record || 'Record'} opened for full review.`, 'next-page': 'The next result page was loaded.', 'review-insights': 'Recommendations opened in priority order.', workflow: 'Workflow action opened.', 'view-all': 'Full activity history opened.', 'primary-task': 'Priority queue opened.', 'download-summary': 'Workspace summary downloaded.', priority: 'Priority task opened.', team: 'Team workspace opened.', upload: 'Product image picker opened.', preview: 'Preview generated from the current form.', security: 'Security centre opened.', 'edit-payment': 'Payout method editor opened.', 'add-payment': 'Add payout method opened.', 'enable-mfa': 'Two-factor authentication setup opened.', sessions: 'Active sessions opened.'
    };
    return messages[action] || 'Action completed successfully.';
  }

  function initEvents() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.getElementById('roleCreateOverlay')?.classList.contains('open')) closeCreateDialog();
    });
    document.addEventListener('input', event => {
      if (event.target.matches('[data-role-table-search]')) filterRoleTable(event.target);
    });
    document.addEventListener('click', event => {
      const settingsButton = event.target.closest('[data-role-settings-tab]');
      if (settingsButton) { event.preventDefault(); setSettingsTab(settingsButton); return; }
      const filter = event.target.closest('[data-role-filter]');
      if (filter) { event.preventDefault(); filterByState(filter); return; }
      const action = event.target.closest('[data-role-action]');
      if (action) {
        event.preventDefault();
        if (action.dataset.roleAction === 'create') { openCreateDialog(action); return; }
        if (['add-payment','edit-payment'].includes(action.dataset.roleAction)) {
          action.dataset.createKind = 'payment-method';
          openCreateDialog(action);
          return;
        }
        window.showToast?.(actionMessage(action.dataset.roleAction, action));
      }
    });
    document.addEventListener('submit', event => {
      if (!event.target.matches('[data-role-form]')) return;
      event.preventDefault();
      window.showToast?.('Changes saved successfully.');
    });
  }

  function init() {
    const nav = document.querySelector('.side-navigation');
    const card = document.querySelector('.sidebar-club-card');
    const sidebar = document.getElementById('sidebar');
    if (!nav || !card) return;
    customerNavMarkup = nav.innerHTML;
    customerSidebarCardMarkup = card.innerHTML;
    buildRolePages();
    buildWorkspaceLabel();
    initEvents();
    const hashPage = location.hash.replace('#','').trim();
    const hashRole = roleForPage(hashPage);
    const savedRole = readStoredRole();
    applyRole(hashRole || (roleProfiles[savedRole] ? savedRole : 'customer'), { navigate: false });
  }

  window.ClassicRoleDashboard = {
    init,
    applyRole,
    ensureRoleForPage,
    roleForPage,
    searchWorkspace,
    getCurrentRole: () => currentRole,
    getDefaultPage: role => roleProfiles[role || currentRole].defaultPage,
    openCreateForm: (kind, title = '') => {
      const trigger = document.createElement('button');
      trigger.dataset.createKind = kind;
      if (title) trigger.dataset.createTitle = title;
      openCreateDialog(trigger);
    }
  };
})();
