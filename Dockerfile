FROM node:22-slim
WORKDIR /app
COPY vendor ./vendor
COPY sim/package.json sim/package-lock.json sim/.npmrc ./sim/
RUN cd sim && npm ci && npm cache clean --force
COPY sim/tsconfig.json ./sim/
COPY sim/src ./sim/src
COPY dashboard ./dashboard
WORKDIR /app/sim
ENV HOST=0.0.0.0 PORT=8787 DARWIN_DB=/tmp/darwin.sqlite
EXPOSE 8787
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/main.ts"]
