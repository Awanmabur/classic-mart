import discoveryRoutes from './routes/discovery.js';
import { isVersionedAsset } from './core/public-assets.js';
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
import { noStore, requestContext, sanitizeBody } from './middleware/request.js';
import { csrfProtection } from './middleware/csrf.js';
import { enforcePrivilegedMfaEnrollment, loadUser } from './middleware/auth.js';
import { countryContext } from './middleware/country.js';
import { viewLocals } from './middleware/view.js';
import { errorHandler, notFound } from './middleware/errors.js';
import healthRoutes from './routes/health.js';
import identityRoutes from './routes/identity.js';
import accountRoutes from './routes/account.js';
import dashboardRoutes from './routes/dashboard.js';
import approvedDashboardRoutes from './routes/approved-dashboard.js';
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
        const url = new URL(response.req.originalUrl, 'http://localhost');
        if (env.isProduction && isVersionedAsset(url.pathname, url.searchParams.get('v'))) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (file === 'sw.js') {
          response.setHeader('Cache-Control', 'no-store, max-age=0');
          response.setHeader('Service-Worker-Allowed', '/');
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
      if (!/rel=["']manifest["']/i.test(rendered)) rendered = rendered.replace(/<\/head>/i, '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/pwa-192.png"><meta name="theme-color" content="#ff6500"><meta name="application-name" content="Classic Mart"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><script src="/pwa.js" defer></script></head>');
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

  // Retired asset URLs must not fall through to dashboard authentication routes.
  app.use((request, response, next) => {
    if (/^\/dashboard-v19(?:\/|$)|^\/account\.css$|^\/dashboard\/(?:assets\/|[^/]+\.(?:css|js|svg|png|jpe?g|webp)$)/i.test(request.path)) {
      return response.status(404).type('text/plain').send('Not found');
    }
    return next();
  });
  app.use(identityRoutes);
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
