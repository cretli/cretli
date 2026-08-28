# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

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
ENV CRETLI_FRONT_HMR=0
ENV CRETLI_BIND=0.0.0.0
ENV USE_HTTPS=1
EXPOSE 3011

VOLUME ["/app/data"]
ENTRYPOINT ["scripts/docker-entrypoint.sh"]
