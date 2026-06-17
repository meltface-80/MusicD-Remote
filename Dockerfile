FROM node:20-alpine

# git  — needed by npm to install GitHub-hosted Roon API packages
# tar  — needed by the in-app updater to extract release tarballs
RUN apk add --no-cache git tar

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js launcher.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY data/ ./data/

ENV PORT=3399
EXPOSE 3399

CMD ["node", "launcher.js"]
