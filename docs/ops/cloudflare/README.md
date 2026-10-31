# Cloudflare / managed edge deployment guidance

Classic Mart's application IDS/IPS is the final application-layer defence, not the Internet edge.

Recommended production order:

```text
Internet
  ↓
DDoS / bot controls
  ↓
Cloudflare managed WAF + custom rules + rate limits
  ↓
Origin firewall/security group
  ↓
Classic Mart optional origin guard
  ↓
Classic Mart application IDS/IPS
  ↓
Authentication / authorization / business services
  ↓
MongoDB
```

## Required operational controls

- Enable current Cloudflare managed WAF rules and bot/DDoS protection appropriate to the plan.
- Apply stricter rate rules to sign-in, verification, password recovery, admin, payment/webhook and API endpoints.
- Block common secret-file and CMS-scanner paths at the edge before they reach the application.
- Restrict origin network access to Cloudflare/reverse-proxy egress ranges or a private load balancer.
- Configure `TRUST_PROXY` for the exact proxy topology; never trust arbitrary forwarded headers from the public Internet.
- Do not cache account, cart, checkout, payment, seller, admin or API responses.
- Cache public immutable/versioned assets and reviewed public catalogue pages only where invalidation is correct.
- Forward WAF/security logs to the same operational monitoring/SIEM program used for Classic Mart security events.
- Test that direct-origin access fails before marking the `waf` launch-evidence gate as passed.

The optional `ORIGIN_GUARD_*` header should be injected by the trusted proxy and stripped from public inbound traffic before insertion.
