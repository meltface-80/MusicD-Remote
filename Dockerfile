FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y git tar python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Quiet, production-only install: no audit/fund/update-notifier chatter, and
# warn-level noise (e.g. better-sqlite3's transitive prebuild-install
# deprecation, which even its latest release still ships) suppressed — real
# errors still print. Vulnerable/deprecated deps are fixed in package.json
# itself (music-metadata >=11 clears both audit findings; node-uuid is
# overridden with the maintained uuid package).
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error

COPY . .

RUN mkdir -p /app/data/cache

VOLUME /app/data

EXPOSE 3399

ENV PORT=3399
ENV DOCKER=1

CMD ["npm","start"]
