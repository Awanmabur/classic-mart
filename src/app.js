import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import hpp from 'hpp';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createSessionMiddleware } from './middleware/session.js';
import { requestContext, sanitizeBody } from './middleware/request.js';
import { csrfProtection } from './middleware/csrf.js';
import { enforcePrivilegedMfaEnrollment, loadUser } from './middleware/auth.js';
import { countryContext } from './middleware/country.js';
import { viewLocals } from './middleware/view.js';
import { errorHandler, notFound } from './middleware/errors.js';
import healthRoutes from './routes/health.js';
import identityRoutes from './routes/identity.js';
import accountRoutes from './routes/account.js';
import mediaRoutes from './routes/media.js';
import moderationRoutes from './routes/moderation.js';
import sellerRoutes from './routes/seller.js';
import storefrontRoutes from './routes/storefront.js';
import newsletterRoutes from './routes/newsletter.js';
import checkoutRoutes from './routes/checkout.js';
import paymentRoutes from './routes/payments.js';
import promoterRoutes from './routes/promoters.js';
import logisticsRoutes from './routes/logistics.js';
import trustRoutes from './routes/trust.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import rewardsRoutes from './routes/rewards.js';
import aiRoutes from './routes/ai.js';
import businessRoutes from './routes/business.js';
import sellerGrowthRoutes from './routes/seller-growth.js';
import stage11Routes from './routes/stage11.js';
import { activeFeatureMap } from './services/stage9.js';
import { AppError } from './core/errors.js';
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
  app.use(
    pinoHttp({
      logger,
      genReqId: (request) => request.id,
      customLogLevel(_request, response, error) {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return env.isProduction ? 'info' : 'silent';
      },
      customSuccessMessage(request, response) {
        return `${request.method} ${request.url} ${response.statusCode}`;
      },
    }),
  );
  app.use(originGuard);
  app.use(securityShield);
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
        if (file === 'sw.js') {
          response.setHeader('Cache-Control', 'no-store, max-age=0');
          response.setHeader('Service-Worker-Allowed', '/');
        } else if (file.endsWith('.js') || file.endsWith('.css')) {
          response.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
        }
      },
    }),
  );
  app.use(healthRoutes);
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
  app.use(enforcePrivilegedMfaEnrollment);
  app.use((request, _response, next) => {
    if (request.adminActor && !['GET','HEAD','OPTIONS'].includes(request.method) && request.path !== '/admin/impersonation/stop') {
      return next(new AppError('Impersonation is read-only. Stop impersonation before changing data.', 403, 'IMPERSONATION_READ_ONLY'));
    }
    return next();
  });
  app.use(countryContext);
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
      let rendered = html;
      if (!/rel=["']manifest["']/i.test(rendered)) rendered = rendered.replace(/<\/head>/i, '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/pwa-192.png"><meta name="theme-color" content="#ff6500"><meta name="application-name" content="Classic Mart"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><script src="/pwa.js" defer></script></head>');
      if (response.locals.impersonation) {
        const info = response.locals.impersonation;
        const banner = `<div style="position:sticky;top:0;z-index:99999;background:#fff4dd;border-bottom:1px solid #e0a100;padding:10px 16px;font:600 14px/1.4 system-ui;color:#4b3900;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap">Read-only impersonation: ${info.actor.name.replace(/[&<>"']/g,'')} viewing ${info.target.name.replace(/[&<>"']/g,'')} (${info.target.role}). <form method="post" action="/admin/impersonation/stop" style="margin:0"><input type="hidden" name="_csrf" value="${response.locals.csrfToken || ''}"><button type="submit" style="border:1px solid #7a5a00;border-radius:999px;background:#fff;padding:5px 10px;font:inherit">Stop impersonation</button></form></div>`;
        rendered = rendered.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      }
      if (callback) return callback(null, rendered);
      return response.send(rendered);
    });
    next();
  });
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (request) => request.path.startsWith('/health/'),
    }),
  );

  app.use(identityRoutes);
  app.use(accountRoutes);
  app.use(rewardsRoutes);
  app.use(aiRoutes);
  app.use(businessRoutes);
  app.use(sellerGrowthRoutes);
  app.use(stage11Routes);
  app.use(mediaRoutes);
  app.use(sellerRoutes);
  app.use(moderationRoutes);
  app.use(storefrontRoutes);
  app.use(newsletterRoutes);
  app.use(checkoutRoutes);
  app.use(paymentRoutes);
  app.use(promoterRoutes);
  app.use(logisticsRoutes);
  app.use(trustRoutes);
  app.use(adminRoutes);
  app.use(publicRoutes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
