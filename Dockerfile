# Build from a folder holding both repos side by side:
#   parent/siege  parent/darwin      docker build -f darwin/Dockerfile -t darwin .
FROM node:22-slim
WORKDIR /app
COPY siege/package.json siege/package-lock.json ./siege/
RUN cd siege && npm ci && npm cache clean --force
COPY siege/tsconfig.json ./siege/
COPY siege/src ./siege/src
COPY darwin/sim/package.json darwin/sim/package-lock.json ./darwin/sim/
RUN cd darwin/sim && npm ci && npm cache clean --force
COPY darwin/sim/tsconfig.json ./darwin/sim/
COPY darwin/sim/src ./darwin/sim/src
COPY darwin/dashboard ./darwin/dashboard
WORKDIR /app/darwin/sim
ENV HOST=0.0.0.0 PORT=8787 DARWIN_DB=/tmp/darwin.sqlite
EXPOSE 8787
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/main.ts"]
