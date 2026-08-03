FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 classicmart \
  && useradd --system --uid 10001 --gid classicmart --home-dir /app classicmart \
  && mkdir -p /app/storage/uploads \
  && chown -R classicmart:classicmart /app/storage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=classicmart:classicmart . .
USER classicmart
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
