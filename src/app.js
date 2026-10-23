import discoveryRoutes from './routes/discovery.js';
import { isVersionedAsset, versionHtmlAssets } from './core/public-assets.js';
import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import rateLimit from './middleware/rate-limit.js';
import helmet from 'helmet';
import hpp from 'hpp';
import { env } from './config/env.js';
import { httpLogging } from './middleware/http-logging.js';
import { createSessionMiddleware } from './middleware/session.js';
import { noStore, requestContext, sanitizeBody } from './middleware/request.js';
import { csrfProtection } from './middleware/csrf.js';
import { enforcePrivilegedMfaEnrollment, loadUser } from './middleware/auth.js';
import { countryContext } from './middleware/country.js';
import { seoContext } from './middleware/seo.js';
import { viewLocals } from './middleware/view.js';
import { errorHandler, notFound } from './middleware/errors.js';
import healthRoutes from './routes/health.js';
import identityRoutes from './routes/identity.js';
import accountRoutes from './routes/account.js';
import dashboardRoutes from './routes/dashboard.js';
import approvedDashboardRoutes from './routes/approved-dashboard.js';
import warehouseRoutes from './routes/warehouse.js';
import businessPageRoutes from './routes/business-pages.js';
import deliveryRoutes from './routes/delivery.js';
import sellerTeamPageRoutes from './routes/seller-team-pages.js';
import sellerAffiliatePageRoutes from './routes/seller-affiliate-pages.js';
import sellerSubscriptionOperationRoutes from './routes/seller-subscription-operations.js';
import sellerTrustCaseRoutes from './routes/seller-trust-cases.js';
import sellerBusinessPageRoutes from './routes/seller-business-pages.js';
import superAdminPageRoutes from './routes/super-admin-pages.js';
import aftersalesPageRoutes from './routes/aftersales-pages.js';
import sellerStoreSettingsRoutes from './routes/seller-store-settings.js';
import sellerVerificationRoutes from './routes/seller-verification.js';
import sellerProductRoutes from './routes/seller-products.js';
import sellerOrderRoutes from './routes/seller-orders.js';
import sellerOverviewRoutes from './routes/seller-overview.js';
import sellerInventoryPageRoutes from './routes/seller-inventory-pages.js';
import sellerRelationshipPageRoutes from './routes/seller-relationship-pages.js';
import sellerFinancePageRoutes from './routes/seller-finance-pages.js';
import sellerGrowthPageRoutes from './routes/seller-growth-pages.js';
import sellerPageAliasRoutes from './routes/seller-page-aliases.js';
import promoterPageAliasRoutes from './routes/promoter-page-aliases.js';
import promoterOverviewRoutes from './routes/promoter-overview.js';
import financePageAliasRoutes from './routes/finance-page-aliases.js';
import financePaymentPageRoutes from './routes/finance-payment-pages.js';
import financePayoutPageRoutes from './routes/finance-payout-pages.js';
import financeReconciliationPageRoutes from './routes/finance-reconciliation-pages.js';
import financeReportPageRoutes from './routes/finance-report-pages.js';
import financeSettingsPageRoutes from './routes/finance-settings-pages.js';
import supportPageAliasRoutes from './routes/support-page-aliases.js';
import supportTicketPageRoutes from './routes/support-ticket-pages.js';
import supportCasePageRoutes from './routes/support-case-pages.js';
import supportContextPageRoutes from './routes/support-context-pages.js';
import supportReportPageRoutes from './routes/support-report-pages.js';
import supportSettingsPageRoutes from './routes/support-settings-pages.js';
import moderationReviewActionRoutes from './routes/moderation-review-actions.js';
import moderationPageAliasRoutes from './routes/moderation-page-aliases.js';
import moderationTrustPageRoutes from './routes/moderation-trust-pages.js';
import moderationReportPageRoutes from './routes/moderation-report-pages.js';
import moderationSettingsPageRoutes from './routes/moderation-settings-pages.js';
import countryAdminPageAliasRoutes from './routes/country-admin-page-aliases.js';
import countryAdminCataloguePageRoutes from './routes/country-admin-catalogue-pages.js';
import countryAdminCommercePageRoutes from './routes/country-admin-commerce-pages.js';
import countryAdminGrowthPageRoutes from './routes/country-admin-growth-pages.js';
import countryAdminReportPageRoutes from './routes/country-admin-report-pages.js';
import countryAdminSettingsPageRoutes from './routes/country-admin-settings-pages.js';
import countryAdminSupportPageRoutes from './routes/country-admin-support-pages.js';
import promoterCampaignPageRoutes from './routes/promoter-campaign-pages.js';
import promoterFinancePageRoutes from './routes/promoter-finance-pages.js';
import promoterRelationshipPageRoutes from './routes/promoter-relationship-pages.js';
import sellerPromoterConversationRoutes from './routes/seller-promoter-conversations.js';
import mediaRoutes from './routes/media.js';
import storefrontRoutes from './routes/storefront.js';
import newsletterRoutes from './routes/newsletter.js';
import checkoutRoutes from './routes/checkout.js';
import paymentRoutes from './routes/payments.js';
import promoterRoutes from './routes/promoters.js';
import trustRoutes from './routes/trust.js';
import publicRoutes from './routes/public.js';
import rewardsRoutes from './routes/rewards.js';
import aiRoutes from './routes/ai.js';
import stage11Routes from './routes/stage11.js';
import { activeFeatureMap } from './services/stage9.js';
import { originGuard, securityShield } from './services/security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(redisClient) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.set('view cache', env.isProduction);

  app.use(requestContext);
  app.use(httpLogging);
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: env.isProduction ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          scriptSrc: [
            "'self'",
            (_request, response) => `'nonce-${response.locals.cspNonce}'`,
          ],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: env.isProduction ? [] : null,
        },
      },
    }),
  );
  app.use(originGuard);
  app.use(securityShield);
  app.use(compression({ threshold: 1_024 }));
  app.use(
    express.static(path.join(root, 'public'), {
      etag: true,
      maxAge: env.isProduction ? '7d' : 0,
      immutable: false,
      index: false,
      fallthrough: true,
      setHeaders(response, filePath) {
        const file = path.basename(filePath).toLowerCase();
        const url = new URL(response.req.originalUrl, 'http://localhost');
        if (env.isProduction && isVersionedAsset(url.pathname, url.searchParams.get('v'))) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (file === 'sw.js') {
          response.setHeader('Cache-Control', 'no-store, max-age=0');
          response.setHeader('Service-Worker-Allowed', '/');
        } else if (file.endsWith('.webmanifest') || file === 'favicon.ico' || file === 'favicon.png') {
          response.setHeader('Cache-Control', 'public, no-cache, max-age=0, must-revalidate');
        } else if (file.endsWith('.js') || file.endsWith('.css')) {
          response.setHeader(
            'Cache-Control',
            env.isProduction
              ? 'public, max-age=300, stale-while-revalidate=3600'
              : 'no-cache, max-age=0, must-revalidate',
          );
        }
      },
    }),
  );
  app.use(healthRoutes);
  app.use(discoveryRoutes);
  // Reject abuse before parsing bodies or loading sessions, actors and page data.
  app.use(rateLimit({
    scope: 'global', windowMs: 60_000, limit: 240,
    standardHeaders: 'draft-8', legacyHeaders: false,
  }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: '320kb',
      parameterLimit: 200,
    }),
  );
  app.use(express.json({ limit: '64kb', strict: true, verify: (request, _response, buffer) => { if (request.originalUrl.startsWith('/webhooks/')) request.rawBody = buffer.toString('utf8'); } }));
  app.use(sanitizeBody);
  app.use(hpp());
  app.use(createSessionMiddleware(redisClient));
  app.use(csrfProtection);
  app.use(loadUser);
  app.use((request, response, next) => request.user ? noStore(request, response, next) : next());
  app.use(enforcePrivilegedMfaEnrollment);
  app.use(countryContext);
  app.use(seoContext);
  app.use(async (request, response, next) => {
    try {
      const identity = request.user?.publicId || request.session?.cartKey || request.ip || 'anonymous';
      const features = mongoose.connection.readyState === 1 ? await activeFeatureMap({ country: request.country?.code, role: request.user?.role || 'customer', identity }) : {};
      request.features = features; response.locals.features = features; next();
    } catch (error) { next(error); }
  });
  app.use(viewLocals);
  app.use((request, response, next) => {
    const original = response.render.bind(response);
    response.render = (view, options = {}, callback) => original(view, options, (error, html) => {
      if (error) return callback ? callback(error) : next(error);
      if (request.user || response.locals.csrfToken || response.locals.flash) noStore(request, response, () => {});
      let rendered = html;
      if (response.statusCode >= 400) response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      if (!/rel=["']manifest["']/i.test(rendered)) rendered = rendered.replace(/<\/head>/i, '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#ff6500"><meta name="application-name" content="Classic Mart"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><script src="/pwa.js" defer></script></head>');
      if (!/rel=["']apple-touch-icon["']/i.test(rendered)) rendered = rendered.replace(/<\/head>/i, '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"></head>');
      rendered = versionHtmlAssets(rendered);
      if (callback) return callback(null, rendered);
      return response.send(rendered);
    });
    next();
  });

  // Retired asset URLs must not fall through to dashboard authentication routes.
  app.use((request, response, next) => {
    if (/^\/dashboard-v19(?:\/|$)|^\/account\.css$|^\/dashboard\/(?:assets\/|[^/]+\.(?:css|js|svg|png|jpe?g|webp)$)/i.test(request.path)) {
      return response.status(404).type('text/plain').send('Not found');
    }
    return next();
  });
  app.use(identityRoutes);
  app.use(superAdminPageRoutes);
  app.use(aftersalesPageRoutes);
  app.use(businessPageRoutes);
  app.use(deliveryRoutes);
  app.use(sellerTeamPageRoutes);
  app.use(sellerAffiliatePageRoutes);
  app.use(sellerSubscriptionOperationRoutes);
  app.use(sellerTrustCaseRoutes);
  app.use(sellerBusinessPageRoutes);
  app.use(sellerStoreSettingsRoutes);
  app.use(moderationPageAliasRoutes);
  app.use(moderationTrustPageRoutes);
  app.use(moderationReportPageRoutes);
  app.use(moderationSettingsPageRoutes);
  app.use(countryAdminPageAliasRoutes);
  app.use(countryAdminCataloguePageRoutes);
  app.use(countryAdminCommercePageRoutes);
  app.use(countryAdminGrowthPageRoutes);
  app.use(countryAdminReportPageRoutes);
  app.use(countryAdminSettingsPageRoutes);
  app.use(countryAdminSupportPageRoutes);
  app.use(sellerVerificationRoutes);
  app.use(sellerProductRoutes);
  app.use(sellerOrderRoutes);
  app.use(sellerOverviewRoutes);
  app.use(sellerPageAliasRoutes);
  app.use(sellerInventoryPageRoutes);
  app.use(sellerRelationshipPageRoutes);
  app.use(sellerFinancePageRoutes);
  app.use(sellerGrowthPageRoutes);
  app.use(sellerPromoterConversationRoutes);
  app.use(promoterPageAliasRoutes);
  app.use(promoterOverviewRoutes);
  app.use(promoterCampaignPageRoutes);
  app.use(promoterFinancePageRoutes);
  app.use(promoterRelationshipPageRoutes);
  app.use(financePageAliasRoutes);
  app.use(financePaymentPageRoutes);
  app.use(financePayoutPageRoutes);
  app.use(financeReconciliationPageRoutes);
  app.use(financeReportPageRoutes);
  app.use(financeSettingsPageRoutes);
  app.use(supportPageAliasRoutes);
  app.use(supportTicketPageRoutes);
  app.use(supportCasePageRoutes);
  app.use(supportContextPageRoutes);
  app.use(supportReportPageRoutes);
  app.use(supportSettingsPageRoutes);
  app.use(moderationReviewActionRoutes);
  app.use(warehouseRoutes);
  app.use(approvedDashboardRoutes);
  app.use(accountRoutes);
  app.use(dashboardRoutes);
  app.use(rewardsRoutes);
  app.use(aiRoutes);
  app.use(stage11Routes);
  app.use(mediaRoutes);
  app.use(storefrontRoutes);
  app.use(newsletterRoutes);
  app.use(checkoutRoutes);
  app.use(paymentRoutes);
  app.use(promoterRoutes);
  app.use(trustRoutes);
  app.use(publicRoutes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
