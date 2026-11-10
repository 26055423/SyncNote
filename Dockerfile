# 1) 图表页（Vela 工作区）用 Node 构建，产物 /chart 是可直接托管的静态文件
FROM node:22-slim AS chart
WORKDIR /src/web/chart-src
COPY web/chart-src/package.json web/chart-src/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/chart-src ./
COPY resources /src/resources
# 镜像自己托管 JS/CSS，共享资源与本地构建保持相同相对路径。
ENV CHART_BASE=/chart/
RUN npm run build

# 2) 运行时仍然只有 Python：镜像里不装 Node，也不需要 npm
FROM python:3.12-slim
WORKDIR /app
COPY *.py ./
COPY resources ./resources
COPY web ./web
# 复制 MQL 源码及文档；具体产品的 include 闭包仍由 local_ea.py 校验并打包。
# bridge/gateway.py 是独立本机组件，不进入服务器镜像。
COPY bridge/*.mq5 bridge/*.mqh bridge/*.md ./bridge/
RUN rm -rf /app/web/chart-src /app/web/chart
COPY --from=chart /src/web/chart ./web/chart
RUN python -c "import os, tempfile; from pathlib import Path; check = tempfile.TemporaryDirectory(); os.environ['DATA_DIR'] = check.name; import app_server, local_ea; [local_ea.source_package(Path.cwd(), product) for product in local_ea.PRODUCTS]; check.cleanup()"
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN chmod -R a+rX /app && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["python", "app_server.py"]
