FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates \
  && freshclam \
  && rm -rf /var/lib/apt/lists/*
ARG BUILD_SHA=
ENV NODE_ENV=production
ENV BUILD_SHA=$BUILD_SHA
ENV NPM_CONFIG_CACHE=/tmp/classicmart-npm-cache
WORKDIR /app
RUN groupadd --system --gid 10001 classicmart \
  && useradd --system --uid 10001 --gid classicmart --home-dir /app classicmart \
  && mkdir -p /var/data/classic-mart/uploads /var/data/classic-mart/exports /var/data/classic-mart/privacy /app/scripts \
  && chown -R classicmart:classicmart /var/data/classic-mart
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY views ./views
COPY scripts/run-production.js scripts/bootstrap-production.js scripts/migrate-production.js scripts/pesapal-register-ipn.js scripts/launch-check.js scripts/check-production-data.js scripts/deploy-smoke.js scripts/backup-drill.js scripts/check-r2.js scripts/launch-evidence.js scripts/staff-access.js scripts/operator-input.js ./scripts/
# Checkouts can have a restrictive umask. Make root-owned code readable to the
# runtime user while keeping only the external storage directories writable.
RUN chmod -R a+rX /app/src /app/public /app/views /app/scripts \
  && chmod -R a-w /app/src /app/public /app/views /app/scripts \
  && chmod 0444 /app/package.json /app/package-lock.json \
  && chmod 0555 /app
USER classicmart
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/run-production.js"]
