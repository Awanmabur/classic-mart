import { CUSTOMER_ROUTES } from './customer-routes.js';
// Classic Mart production dashboard page registry.
// Visual labels/page structure are intentionally preserved; route targets bind the design to production server routes.

export const DASHBOARD_WORKSPACES = Object.freeze({
  "customer": {
    "label": "Customer",
    "defaultPage": "dashboard",
    "search": "Search products, brands and orders...",
    "quickLabel": "Categories",
    "quickPage": "categories",
    "notificationPage": "notifications"
  },
  "seller": {
    "label": "Seller",
    "defaultPage": "seller-store",
    "search": "Search products, orders and customers...",
    "quickLabel": "Add Product",
    "quickPage": "seller-add-product",
    "notificationPage": "seller-messages"
  },
  "promoter": {
    "label": "Promoter",
    "defaultPage": "promoter-overview",
    "search": "Search campaigns, links and conversions...",
    "quickLabel": "Create Link",
    "quickPage": "promoter-links",
    "notificationPage": "promoter-messages"
  },
  "admin": {
    "label": "Admin",
    "defaultPage": "admin-overview",
    "search": "Search users, orders, products and tickets...",
    "quickLabel": "Operations",
    "quickPage": "admin-orders",
    "notificationPage": "admin-support"
  },
  "superadmin": {
    "label": "Super Admin",
    "defaultPage": "super-overview",
    "search": "Search the entire Classic Mart platform...",
    "quickLabel": "System Health",
    "quickPage": "super-security",
    "notificationPage": "super-notifications"
  },
  "finance": {
    "label": "Finance",
    "defaultPage": "finance-overview",
    "search": "Search payments, refunds, payouts and settlements...",
    "quickLabel": "Reconcile",
    "quickPage": "finance-reconciliation",
    "notificationPage": "finance-reconciliation"
  },
  "support": {
    "label": "Support",
    "defaultPage": "support-overview",
    "search": "Search tickets, customers, orders and disputes...",
    "quickLabel": "Ticket Queue",
    "quickPage": "support-queue",
    "notificationPage": "support-queue"
  },
  "warehouse": {
    "label": "Warehouse",
    "defaultPage": "warehouse-overview",
    "search": "Search inventory, orders, shipments and returns...",
    "quickLabel": "Dispatch",
    "quickPage": "warehouse-dispatch",
    "notificationPage": "warehouse-dispatch"
  },
  "moderator": {
    "label": "Moderation",
    "defaultPage": "moderator-sellers",
    "search": "Search products, reviews, sellers and risk cases...",
    "quickLabel": "Review Queue",
    "quickPage": "moderator-products",
    "notificationPage": "moderator-products"
  },
  "business": {
    "label": "Business Buyer",
    "defaultPage": "business-overview",
    "search": "Search orders, suppliers, documents and spend...",
    "quickLabel": "Orders",
    "quickPage": "business-orders",
    "notificationPage": "business-orders"
  }
});

export const DASHBOARD_PAGES = Object.freeze({
  "customer": [
    [
      "dashboard",
      "Dashboard",
      "i-grid",
      "Account",
      "Dashboard",
      "See your orders, rewards, alerts, memberships and account activity.",
      "overview"
    ],
    [
      "orders",
      "My Orders",
      "i-clipboard",
      "Shopping",
      "My Orders",
      "Track purchases, payment, fulfilment, delivery, returns and refunds.",
      "orders"
    ],
    [
      "wishlist",
      "Wishlist",
      "i-heart",
      "Shopping",
      "Wishlist",
      "Keep products you want to revisit and buy later.",
      "wishlist"
    ],
    [
      "addresses",
      "Addresses",
      "i-pin",
      "Account",
      "Addresses",
      "Manage delivery addresses and preferred delivery details.",
      "addresses"
    ],
    [
      "rewards",
      "Rewards",
      "i-award",
      "Benefits",
      "Rewards",
      "Review points, referral rewards, gift cards and loyalty benefits.",
      "rewards"
    ],
    [
      "wallet",
      "Wallet",
      "i-wallet",
      "Money",
      "Wallet",
      "Review account money activity and available payment balances.",
      "wallet"
    ],
    [
      "returns",
      "Returns & Refunds",
      "i-refresh",
      "Shopping",
      "Returns & Refunds",
      "Track return eligibility, pickup, inspection and refund progress.",
      "returns"
    ],
    [
      "support",
      "Support Tickets",
      "i-support",
      "Help",
      "Support Tickets",
      "Get help with orders, returns, account questions and marketplace issues.",
      "support"
    ],
    [
      "profile",
      "Profile Settings",
      "i-user",
      "Account",
      "Profile Settings",
      "Manage your personal details, preferences and account profile.",
      "profile"
    ],
    [
      "categories",
      "Categories",
      "i-grid",
      "Marketplace",
      "Categories",
      "Browse the marketplace by category.",
      "categories"
    ],
    [
      "notifications",
      "Notifications",
      "i-bell",
      "Account",
      "Notifications",
      "Review important marketplace and account updates.",
      "notifications"
    ],
    [
      "cart",
      "Cart",
      "i-cart",
      "Shopping",
      "Cart",
      "Review products before checkout.",
      "cart"
    ],
    [
      "club",
      "Classic Club",
      "i-crown",
      "Benefits",
      "Classic Club",
      "Review membership benefits and loyalty progress.",
      "club"
    ]
  ],
  "superadmin": [
    [
      "super-overview",
      "Overview",
      "i-grid",
      "Command centre",
      "Platform Overview",
      "Monitor marketplace growth, operations, trust, finance, and infrastructure from one command centre.",
      "overview"
    ],
    [
      "super-analytics",
      "Platform Analytics",
      "i-eye",
      "Command centre",
      "Platform Analytics",
      "Compare revenue, traffic, retention, fulfilment, and conversion trends across the entire marketplace.",
      "analytics"
    ],
    [
      "super-users",
      "All Users",
      "i-user",
      "People & access",
      "User Management",
      "Search, verify, suspend, restore, and understand every account on Classic Mart.",
      "users"
    ],
    [
      "super-roles",
      "Roles & Permissions",
      "i-shield",
      "People & access",
      "Roles & Permissions",
      "Create controlled access policies for operational teams and platform administrators.",
      "roles"
    ],
    [
      "super-admins",
      "Admin Accounts",
      "i-user",
      "People & access",
      "Admin Accounts",
      "Manage administrators, assigned departments, access status, and recent activity.",
      "admins"
    ],
    [
      "super-sellers",
      "Sellers",
      "i-bag",
      "Marketplace",
      "Seller Management",
      "Review seller health, compliance, sales quality, and account standing.",
      "sellers"
    ],
    [
      "super-promoters",
      "Promoters",
      "i-award",
      "Marketplace",
      "Promoter Management",
      "Track promoter quality, campaign performance, verification, and commission exposure.",
      "promoters"
    ],
    [
      "super-customers",
      "Customers",
      "i-user",
      "Marketplace",
      "Customer Management",
      "Understand customer value, account status, retention, and support risk.",
      "customers"
    ],
    [
      "super-products",
      "Product Moderation",
      "i-box",
      "Marketplace",
      "Product Moderation",
      "Approve listings, resolve policy flags, and maintain catalogue quality.",
      "products"
    ],
    [
      "super-categories",
      "Category Control",
      "i-grid",
      "Marketplace",
      "Category Control",
      "Manage the global category tree, attributes, commission rules, and visibility.",
      "categories"
    ],
    [
      "super-orders",
      "Global Orders",
      "i-clipboard",
      "Commerce",
      "Global Orders",
      "Supervise order flow, fulfilment exceptions, high-risk activity, and service levels.",
      "orders"
    ],
    [
      "super-finance",
      "Payments & Finance",
      "i-wallet",
      "Commerce",
      "Payments & Finance",
      "Control payment settlement, marketplace revenue, refunds, reserves, and reconciliation.",
      "finance"
    ],
    [
      "super-commissions",
      "Commission Rules",
      "i-award",
      "Commerce",
      "Commission Rules",
      "Manage seller fees, promoter rates, category rules, and incentive programmes.",
      "commissions"
    ],
    [
      "super-subscriptions",
      "Subscriptions",
      "i-card",
      "Commerce",
      "Subscriptions",
      "Manage seller plans, promoter tiers, billing cycles, renewals, and plan adoption.",
      "subscriptions"
    ],
    [
      "super-disputes",
      "Disputes & Risk",
      "i-refresh",
      "Trust & safety",
      "Disputes & Risk",
      "Resolve escalated disputes, payment risk, abuse signals, and protected transactions.",
      "disputes"
    ],
    [
      "super-reports",
      "Reports Centre",
      "i-download",
      "Intelligence",
      "Reports Centre",
      "Build, schedule, and export reliable operational and financial reports.",
      "reports"
    ],
    [
      "super-audit",
      "Audit Logs",
      "i-eye",
      "Trust & safety",
      "Audit Logs",
      "Review sensitive actions, login events, configuration changes, and data exports.",
      "audit"
    ],
    [
      "super-security",
      "Security & System Health",
      "i-shield",
      "Trust & safety",
      "Security & System Health",
      "Monitor infrastructure availability, security controls, backups, and integration health.",
      "security"
    ],
    [
      "super-notifications",
      "Platform Notifications",
      "i-bell",
      "Engagement",
      "Platform Notifications",
      "Create targeted announcements, transactional notices, and emergency communications.",
      "notifications"
    ],
    [
      "super-support",
      "Escalated Support",
      "i-support",
      "Operations",
      "Escalated Support",
      "Handle high-priority marketplace cases and review support team performance.",
      "support"
    ],
    [
      "super-settings",
      "System Settings",
      "i-user",
      "Configuration",
      "System Settings",
      "Configure global marketplace identity, currencies, taxes, policies, and integrations.",
      "settings"
    ]
  ],
  "admin": [
    [
      "admin-overview",
      "Overview",
      "i-grid",
      "Operations",
      "Admin Overview",
      "Run day-to-day marketplace operations, approvals, fulfilment, content, and customer care.",
      "overview"
    ],
    [
      "admin-seller-approvals",
      "Seller Approvals",
      "i-bag",
      "Approvals",
      "Seller Approvals",
      "Verify business documents, store readiness, and seller compliance before activation.",
      "approvals"
    ],
    [
      "admin-promoter-approvals",
      "Promoter Approvals",
      "i-award",
      "Approvals",
      "Promoter Approvals",
      "Review promoter identity, channels, audience quality, and programme eligibility.",
      "approvals"
    ],
    [
      "admin-customers",
      "Customers",
      "i-user",
      "People",
      "Customer Accounts",
      "Support customers, review account status, and resolve access or verification issues.",
      "customers"
    ],
    [
      "admin-products",
      "Products",
      "i-box",
      "Catalogue",
      "Product Management",
      "Review listings, fix catalogue issues, and keep active products accurate and compliant.",
      "products"
    ],
    [
      "admin-categories",
      "Categories",
      "i-grid",
      "Catalogue",
      "Category Management",
      "Maintain category structure, attributes, brands, and merchandising visibility.",
      "categories"
    ],
    [
      "admin-orders",
      "Orders",
      "i-clipboard",
      "Commerce",
      "Order Operations",
      "Track fulfilment, intervene in exceptions, and maintain delivery service levels.",
      "orders"
    ],
    [
      "admin-returns",
      "Returns & Refunds",
      "i-refresh",
      "Commerce",
      "Returns & Refunds",
      "Approve return requests, coordinate pickups, and monitor refund completion.",
      "returns"
    ],
    [
      "admin-payments",
      "Payments",
      "i-wallet",
      "Commerce",
      "Payment Operations",
      "Review captured payments, failed transactions, refunds, and reconciliation exceptions.",
      "finance"
    ],
    [
      "admin-coupons",
      "Coupons",
      "i-tag",
      "Growth",
      "Coupon Management",
      "Create controlled offers, define eligibility, and measure coupon usage.",
      "coupons"
    ],
    [
      "admin-campaigns",
      "Campaigns",
      "i-award",
      "Growth",
      "Campaign Management",
      "Plan marketplace campaigns, assign inventory, and coordinate sellers and promoters.",
      "campaigns"
    ],
    [
      "admin-reviews",
      "Reviews",
      "i-star",
      "Trust",
      "Review Moderation",
      "Protect authentic reviews and resolve flagged, abusive, or misleading content.",
      "reviews"
    ],
    [
      "admin-support",
      "Support Tickets",
      "i-support",
      "Service",
      "Support Tickets",
      "Manage ticket queues, ownership, response time, and customer satisfaction.",
      "support"
    ],
    [
      "admin-content",
      "Content & Banners",
      "i-message",
      "Content",
      "Content Management",
      "Publish homepage sections, campaign banners, help content, and marketplace announcements.",
      "content"
    ],
    [
      "admin-reports",
      "Reports",
      "i-download",
      "Intelligence",
      "Operational Reports",
      "Export daily operational, seller, product, order, and customer reports.",
      "reports"
    ],
    [
      "admin-settings",
      "Admin Settings",
      "i-user",
      "Configuration",
      "Admin Settings",
      "Manage notification preferences, assigned workflows, profile, and session security.",
      "settings"
    ]
  ],
  "seller": [
    [
      "seller-overview",
      "Overview",
      "i-grid",
      "Store",
      "Seller Overview",
      "See sales, orders, inventory risk, customer satisfaction, and store actions at a glance.",
      "overview"
    ],
    [
      "seller-products",
      "Products",
      "i-box",
      "Catalogue",
      "My Products",
      "Manage product information, publishing status, prices, images, and marketplace visibility.",
      "products"
    ],
    [
      "seller-add-product",
      "Add Product",
      "i-plus",
      "Catalogue",
      "Add a Product",
      "Create a complete product listing with pricing, stock, variants, media, and delivery details.",
      "form-product"
    ],
    [
      "seller-inventory",
      "Inventory",
      "i-box",
      "Catalogue",
      "Inventory Management",
      "Track stock levels, low-stock warnings, reserved quantities, and warehouse availability.",
      "inventory"
    ],
    [
      "seller-orders",
      "Orders",
      "i-clipboard",
      "Fulfilment",
      "Seller Orders",
      "Accept, prepare, ship, and complete customer orders within marketplace service levels.",
      "orders"
    ],
    [
      "seller-shipping",
      "Shipping",
      "i-truck",
      "Fulfilment",
      "Shipping & Delivery",
      "Manage pickup addresses, courier handover, tracking, and delivery performance.",
      "shipping"
    ],
    [
      "seller-returns",
      "Returns",
      "i-refresh",
      "Fulfilment",
      "Returns & Refunds",
      "Review return reasons, approve requests, receive items, and follow refund status.",
      "returns"
    ],
    [
      "seller-customers",
      "Customers",
      "i-user",
      "Relationships",
      "Customers",
      "Understand repeat buyers, customer value, questions, and post-purchase needs.",
      "customers"
    ],
    [
      "seller-promotions",
      "Promotions",
      "i-award",
      "Growth",
      "Promotions",
      "Join marketplace campaigns and create product discounts that protect your margins.",
      "campaigns"
    ],
    [
      "seller-coupons",
      "Coupons",
      "i-tag",
      "Growth",
      "Seller Coupons",
      "Create store-level coupon codes with usage, product, and customer restrictions.",
      "coupons"
    ],
    [
      "seller-earnings",
      "Earnings",
      "i-wallet",
      "Finance",
      "Earnings & Wallet",
      "Review gross sales, fees, refunds, available balance, and upcoming settlement.",
      "finance"
    ],
    [
      "seller-payouts",
      "Payouts",
      "i-card",
      "Finance",
      "Payouts",
      "Manage settlement methods, payout schedules, completed transfers, and payment holds.",
      "payouts"
    ],
    [
      "seller-analytics",
      "Analytics",
      "i-eye",
      "Intelligence",
      "Store Analytics",
      "Measure traffic, conversion, products, customers, campaigns, and revenue trends.",
      "analytics"
    ],
    [
      "seller-reviews",
      "Reviews",
      "i-star",
      "Relationships",
      "Product Reviews",
      "Read customer feedback, respond professionally, and improve product quality.",
      "reviews"
    ],
    [
      "seller-messages",
      "Messages",
      "i-message",
      "Relationships",
      "Customer Messages",
      "Answer product questions, order enquiries, and platform conversations efficiently.",
      "messages"
    ],
    [
      "seller-store",
      "Store Settings",
      "i-bag",
      "Configuration",
      "Store Settings",
      "Manage your store identity, business details, policies, pickup locations, and team access.",
      "settings-store"
    ],
    [
      "seller-subscription",
      "Subscription",
      "i-crown",
      "Configuration",
      "Seller Subscription",
      "Compare plans, review current benefits, billing history, and upgrade options.",
      "subscriptions"
    ]
  ],
  "promoter": [
    [
      "promoter-overview",
      "Overview",
      "i-grid",
      "Workspace",
      "Promoter Overview",
      "Track active campaigns, clicks, conversions, commissions, and opportunities in one place.",
      "overview"
    ],
    [
      "promoter-marketplace",
      "Campaign Marketplace",
      "i-award",
      "Campaigns",
      "Campaign Marketplace",
      "Discover approved products and seller campaigns that match your audience.",
      "campaigns-market"
    ],
    [
      "promoter-campaigns",
      "Active Campaigns",
      "i-tag",
      "Campaigns",
      "Active Campaigns",
      "Manage accepted campaigns, requirements, content deadlines, and performance.",
      "campaigns"
    ],
    [
      "promoter-links",
      "Tracking Links",
      "i-arrow-right",
      "Promotion tools",
      "Tracking Links",
      "Create, organise, and monitor attributed product and campaign links.",
      "links"
    ],
    [
      "promoter-content",
      "Content Library",
      "i-message",
      "Promotion tools",
      "Content Library",
      "Access approved product images, captions, campaign briefs, and brand guidelines.",
      "content"
    ],
    [
      "promoter-traffic",
      "Traffic & Clicks",
      "i-eye",
      "Performance",
      "Traffic & Clicks",
      "Understand channel traffic, click quality, devices, locations, and engagement.",
      "traffic"
    ],
    [
      "promoter-conversions",
      "Conversions & Orders",
      "i-clipboard",
      "Performance",
      "Conversions & Orders",
      "Track attributed orders, approval status, returns, and conversion value.",
      "conversions"
    ],
    [
      "promoter-commissions",
      "Commissions",
      "i-award",
      "Finance",
      "Commissions",
      "Review pending, approved, reversed, and paid campaign commission.",
      "commissions"
    ],
    [
      "promoter-wallet",
      "Wallet",
      "i-wallet",
      "Finance",
      "Promoter Wallet",
      "See available earnings, pending commission, bonuses, and wallet transactions.",
      "finance"
    ],
    [
      "promoter-payouts",
      "Payouts",
      "i-card",
      "Finance",
      "Payouts",
      "Manage payout details, withdrawal requests, settlement timing, and payment history.",
      "payouts"
    ],
    [
      "promoter-analytics",
      "Analytics",
      "i-eye",
      "Performance",
      "Promoter Analytics",
      "Compare campaigns, channels, content, products, and audience conversion trends.",
      "analytics"
    ],
    [
      "promoter-referrals",
      "Referrals",
      "i-user",
      "Growth",
      "Promoter Referrals",
      "Invite qualified promoters, track activation, and earn referral bonuses.",
      "referrals"
    ],
    [
      "promoter-brands",
      "Sellers & Brands",
      "i-bag",
      "Partnerships",
      "Sellers & Brands",
      "Follow trusted sellers, review collaboration invitations, and manage relationships.",
      "brands"
    ],
    [
      "promoter-messages",
      "Messages",
      "i-message",
      "Partnerships",
      "Messages",
      "Communicate with sellers, campaign managers, and Classic Mart support.",
      "messages"
    ],
    [
      "promoter-profile",
      "Profile Settings",
      "i-user",
      "Configuration",
      "Promoter Profile",
      "Manage channels, audience details, payout information, preferences, and security.",
      "settings-promoter"
    ]
  ],
  "finance": [
    [
      "finance-overview",
      "Overview",
      "i-grid",
      "Finance",
      "Finance Overview",
      "Monitor captured funds, refunds, settlement exposure, payout risk, and reconciliation work.",
      "overview"
    ],
    [
      "finance-payments",
      "Payments",
      "i-card",
      "Money movement",
      "Payment Operations",
      "Review provider status, captured payments, failures, chargebacks, and payment exceptions.",
      "finance"
    ],
    [
      "finance-refunds",
      "Refunds",
      "i-refresh",
      "Money movement",
      "Refund Operations",
      "Track refund eligibility, approvals, provider completion, and unresolved money movement.",
      "returns"
    ],
    [
      "finance-payouts",
      "Payouts",
      "i-wallet",
      "Money movement",
      "Payout Operations",
      "Review seller and promoter payouts, holds, submission status, and settlement evidence.",
      "payouts"
    ],
    [
      "finance-reconciliation",
      "Reconciliation",
      "i-check",
      "Controls",
      "Reconciliation Centre",
      "Match provider truth to the internal ledger and resolve every exception without duplicate movement.",
      "reports"
    ],
    [
      "finance-disputes",
      "Chargebacks & Disputes",
      "i-shield",
      "Controls",
      "Financial Disputes",
      "Investigate chargebacks, payment disputes, evidence deadlines, and protected balances.",
      "disputes"
    ],
    [
      "finance-reports",
      "Reports",
      "i-download",
      "Intelligence",
      "Finance Reports",
      "Prepare settlement, revenue, refund, payout, and audit-ready financial exports.",
      "reports"
    ],
    [
      "finance-audit",
      "Audit Trail",
      "i-eye",
      "Controls",
      "Finance Audit Trail",
      "Review privileged money actions, approvals, exports, and reconciliation decisions.",
      "audit"
    ],
    [
      "finance-settings",
      "Finance Settings",
      "i-user",
      "Configuration",
      "Finance Settings",
      "Manage finance notifications, review preferences, sessions, and controlled workspace settings.",
      "settings"
    ]
  ],
  "support": [
    [
      "support-overview",
      "Overview",
      "i-grid",
      "Service",
      "Support Overview",
      "See queue health, response time, escalations, CSAT, and the cases that need action now.",
      "overview"
    ],
    [
      "support-queue",
      "Ticket Queue",
      "i-support",
      "Service",
      "Support Ticket Queue",
      "Own, prioritize, transfer, respond to, and resolve customer and partner support requests.",
      "support"
    ],
    [
      "support-customers",
      "Customer Lookup",
      "i-user",
      "Service",
      "Customer Lookup",
      "Find customer history, order context, account state, and safe support actions in one place.",
      "customers"
    ],
    [
      "support-orders",
      "Order Help",
      "i-clipboard",
      "Commerce",
      "Order Support",
      "Investigate order status, delivery exceptions, cancellations, and buyer-protection questions.",
      "orders"
    ],
    [
      "support-returns",
      "Returns & Refunds",
      "i-refresh",
      "Commerce",
      "Returns Support",
      "Help customers through eligibility, pickup, inspection, refund status, and escalation.",
      "returns"
    ],
    [
      "support-disputes",
      "Escalations",
      "i-shield",
      "Trust",
      "Escalated Cases",
      "Coordinate high-risk disputes, evidence, specialist review, and documented outcomes.",
      "disputes"
    ],
    [
      "support-reviews",
      "Review Issues",
      "i-star",
      "Trust",
      "Review Issues",
      "Handle review disputes and authenticity questions without bypassing moderation controls.",
      "reviews"
    ],
    [
      "support-reports",
      "Service Reports",
      "i-download",
      "Intelligence",
      "Support Reports",
      "Track SLA, backlog, transfer quality, CSAT, resolution reasons, and staffing trends.",
      "reports"
    ],
    [
      "support-settings",
      "Support Settings",
      "i-user",
      "Configuration",
      "Support Settings",
      "Manage queue preferences, notifications, profile, sessions, and workspace security.",
      "settings"
    ]
  ],
  "warehouse": [
    [
      "warehouse-overview",
      "Overview",
      "i-grid",
      "Fulfilment",
      "Warehouse Overview",
      "Monitor receiving, inventory, picking, packing, dispatch, exceptions, and return intake.",
      "overview"
    ],
    [
      "warehouse-inventory",
      "Inventory",
      "i-box",
      "Stock",
      "Inventory Control",
      "Track available, reserved, damaged, low-stock, and cycle-count quantities by SKU.",
      "inventory"
    ],
    [
      "warehouse-receiving",
      "Receiving",
      "i-download",
      "Stock",
      "Receiving",
      "Record inbound stock, purchase references, variances, damage, and put-away readiness.",
      "inventory"
    ],
    [
      "warehouse-picking",
      "Picking",
      "i-clipboard",
      "Fulfilment",
      "Picking Queue",
      "Prioritize paid orders, pick exact SKUs, confirm quantities, and surface stock exceptions.",
      "orders"
    ],
    [
      "warehouse-packing",
      "Packing",
      "i-box",
      "Fulfilment",
      "Packing Station",
      "Verify picked items, package safely, prepare labels, and prevent duplicate completion.",
      "orders"
    ],
    [
      "warehouse-dispatch",
      "Dispatch",
      "i-truck",
      "Fulfilment",
      "Dispatch",
      "Handover parcels to couriers with custody evidence, tracking, and service-level visibility.",
      "shipping"
    ],
    [
      "warehouse-returns",
      "Return Intake",
      "i-refresh",
      "Reverse logistics",
      "Return Intake",
      "Receive returned parcels, record condition, route inspection, and update stock disposition.",
      "returns"
    ],
    [
      "warehouse-reports",
      "Warehouse Reports",
      "i-download",
      "Intelligence",
      "Warehouse Reports",
      "Review stock movement, fulfilment speed, variance, courier handover, and cycle-count accuracy.",
      "reports"
    ],
    [
      "warehouse-settings",
      "Warehouse Settings",
      "i-user",
      "Configuration",
      "Warehouse Settings",
      "Manage workstation preferences, notifications, profile, and secure session controls.",
      "settings"
    ]
  ],
  "moderator": [
    [
      "moderator-overview",
      "Overview",
      "i-grid",
      "Trust",
      "Moderation Overview",
      "See catalogue, review, seller, and risk queues with clear priority and evidence context.",
      "overview"
    ],
    [
      "moderator-products",
      "Product Queue",
      "i-box",
      "Catalogue trust",
      "Product Moderation",
      "Review prohibited items, counterfeit risk, listing accuracy, evidence, and appeals.",
      "products"
    ],
    [
      "moderator-reviews",
      "Review Queue",
      "i-star",
      "Content trust",
      "Review Moderation",
      "Protect verified reviews, detect manipulation, and resolve disputes with recorded reasons.",
      "reviews"
    ],
    [
      "moderator-sellers",
      "Seller Compliance",
      "i-bag",
      "Marketplace trust",
      "Seller Compliance",
      "Review seller health, policy signals, verification state, and corrective action.",
      "sellers"
    ],
    [
      "moderator-disputes",
      "Risk Cases",
      "i-shield",
      "Risk",
      "Risk Cases",
      "Investigate abuse signals, protected transactions, evidence, escalation, and appeal status.",
      "disputes"
    ],
    [
      "moderator-audit",
      "Moderation Audit",
      "i-eye",
      "Controls",
      "Moderation Audit",
      "Review sensitive moderation actions, evidence access, exports, and decision history.",
      "audit"
    ],
    [
      "moderator-reports",
      "Trust Reports",
      "i-download",
      "Intelligence",
      "Trust & Safety Reports",
      "Measure queue age, decision quality, appeal outcomes, repeat abuse, and policy trends.",
      "reports"
    ],
    [
      "moderator-settings",
      "Moderation Settings",
      "i-user",
      "Configuration",
      "Moderation Settings",
      "Manage alerts, profile, review preferences, sessions, and account security.",
      "settings"
    ]
  ],
  "business": [
    [
      "business-overview",
      "Overview",
      "i-grid",
      "Business",
      "Business Overview",
      "Track company purchasing, supplier activity, order status, spend, and finance controls.",
      "overview"
    ],
    [
      "business-orders",
      "Business Orders",
      "i-clipboard",
      "Procurement",
      "Business Orders",
      "Manage company purchases, approvals, delivery status, and order documents.",
      "orders"
    ],
    [
      "business-suppliers",
      "Suppliers",
      "i-bag",
      "Procurement",
      "Supplier Directory",
      "Review approved marketplace sellers, relationship quality, and supply performance.",
      "sellers"
    ],
    [
      "business-payments",
      "Payments",
      "i-card",
      "Finance",
      "Business Payments",
      "Track company payment activity, refunds, wallet use, and reconciliation context.",
      "finance"
    ],
    [
      "business-reports",
      "Spend Reports",
      "i-download",
      "Intelligence",
      "Spend Reports",
      "Review procurement spend, supplier mix, order performance, and exportable finance summaries.",
      "reports"
    ],
    [
      "business-settings",
      "Business Settings",
      "i-user",
      "Configuration",
      "Business Settings",
      "Manage company profile, notifications, sessions, and secure workspace preferences.",
      "settings"
    ]
  ]
});

export function pageDefinition(workspace, pageId) {
  const rows = DASHBOARD_PAGES[workspace] || [];
  return rows.find((row) => row[0] === pageId) || null;
}

export function pageWorkspace(pageId) {
  for (const [workspace, rows] of Object.entries(DASHBOARD_PAGES)) {
    if (rows.some((row) => row[0] === pageId)) return workspace;
  }
  return null;
}

export function defaultPageFor(workspace) {
  return DASHBOARD_WORKSPACES[workspace]?.defaultPage || 'dashboard';
}

export function routeForPage(pageId) {
  if (pageId === 'seller-store') return '/seller/store';
  if (pageId === 'moderator-sellers') return '/moderation/verifications';
  return CUSTOMER_ROUTES[pageId] || (pageWorkspace(pageId) ? `/dashboard/${encodeURIComponent(pageId)}` : '/dashboard');
}

export const DASHBOARD_PAGE_COUNT = Object.freeze(
  Object.values(DASHBOARD_PAGES).reduce((total, pages) => total + pages.length, 0),
);
