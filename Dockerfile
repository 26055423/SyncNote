# 1) 图表页（Vela 工作区）用 Node 构建，产物 /chart 是可直接托管的静态文件
FROM node:22-slim AS chart
WORKDIR /src
COPY web/chart-src/package.json web/chart-src/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/chart-src ./
RUN npm run build

# 2) 运行时仍然只有 Python：镜像里不装 Node，也不需要 npm
FROM python:3.12-slim
WORKDIR /app
COPY app_server.py auth_security.py chart.py client_address.py challenge_image.py journal.py market.py trade_time.py bootstrap_admin.py ./
COPY web ./web
RUN rm -rf /app/web/chart-src /app/web/chart
COPY --from=chart /chart ./web/chart
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN chmod -R a+rX /app && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["python", "app_server.py"]
