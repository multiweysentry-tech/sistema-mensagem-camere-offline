# Build a partir da raiz do repositório:
#   docker build -f wa-server/Dockerfile -t multiwey-wa-server .
FROM node:20-bookworm-slim

WORKDIR /app/wa-server
COPY wa-server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

WORKDIR /app
COPY phone-utils.js ./phone-utils.js
COPY wa-server/ ./wa-server/
RUN mkdir -p /app/session

ENV NODE_ENV=production
ENV SESSION_DIR=/app/session
EXPOSE 3001

# Use: docker run --env-file wa-server/.env -v wa-session:/app/session ...
CMD ["node", "wa-server/index.js"]
