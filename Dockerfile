FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates \
  && freshclam \
  && rm -rf /var/lib/apt/lists/*
ARG BUILD_SHA=unknown
ENV NODE_ENV=production
ENV BUILD_SHA=$BUILD_SHA
WORKDIR /app
RUN groupadd --system --gid 10001 classicmart \
  && useradd --system --uid 10001 --gid classicmart --home-dir /app classicmart \
  && mkdir -p /var/data/classic-mart/uploads /var/data/classic-mart/exports /var/data/classic-mart/privacy /app/scripts \
  && chown -R classicmart:classicmart /var/data/classic-mart /app/scripts
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=classicmart:classicmart package.json package-lock.json ./
COPY --chown=classicmart:classicmart src ./src
COPY --chown=classicmart:classicmart public ./public
COPY --chown=classicmart:classicmart views ./views
COPY --chown=classicmart:classicmart scripts/run-production.js scripts/bootstrap-production.js scripts/migrate-production.js scripts/pesapal-register-ipn.js scripts/launch-check.js scripts/check-production-data.js scripts/deploy-smoke.js scripts/backup-drill.js ./scripts/
USER classicmart
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/run-production.js"]
