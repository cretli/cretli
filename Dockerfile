# syntax=docker/dockerfile:1
# The floating 22 tag always resolves to the latest 22.x; the check below fails the
# build if the image ever resolves below engines.node (>=22.18, native type stripping).
FROM node:22-bookworm-slim
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<18)){console.error('Node >= 22.18 required, got '+process.version);process.exit(1)}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY app_front/package.json ./app_front/
RUN npm ci

COPY . .
RUN chmod +x scripts/docker-entrypoint.sh \
  && npm run build:front:prod

ENV NODE_ENV=production
ENV CRETLI_BIND=0.0.0.0
ENV USE_HTTPS=1
EXPOSE 3011

VOLUME ["/app/data"]
ENTRYPOINT ["scripts/docker-entrypoint.sh"]
