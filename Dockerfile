# Debian-Basis statt Alpine: ONNX Runtime (für die lokalen Embeddings der semantischen Suche)
# braucht glibc und läuft nicht auf Alpine/musl.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Hier speichert die App das Embedding-Modell (ca. 120 MB, wird beim ersten Start heruntergeladen).
# In docker-compose als Volume eingebunden, damit es nach einem Neustart nicht neu geladen wird.
ENV EMBEDDINGS_CACHE_DIR=/app/.cache/models
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY widget ./widget
COPY web ./web
RUN mkdir -p /app/.cache/models && chown -R node:node /app/.cache
USER node
EXPOSE 3000
# wget gibt es im slim-Image nicht → Healthcheck mit Node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
