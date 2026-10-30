# Node 24.22.1 includes the 21 Oct 2026 security fixes. Never use node 20 (end-of-life).
FROM node:24.22.1-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install exactly what package-lock.json says, without running package install scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 # The bot never needs npm/yarn at run time; removing them shrinks the attack surface.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm

# App code stays owned by root, so the node user can read but not modify it.
COPY src ./src

# State lives on a volume; it is the only writable place besides the /tmp tmpfs.
RUN mkdir /data && chown node:node /data
ENV DATA_FILE=/data/state.json
VOLUME /data

# Tokens are passed as env at run time, never baked in.
USER node
CMD ["node", "src/index.js"]
