# 1) 图表页（Vela 工作区）用 Node 构建，产物 /chart 是可直接托管的静态文件
FROM node:22-slim AS chart
WORKDIR /src
COPY web/chart-src/package.json web/chart-src/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/chart-src ./
# 镜像自己托管 JS/CSS：默认的 jsDelivr base 会让运行时依赖外网，且与仓库里带的那份产物不一致。
ENV CHART_BASE=/chart/
RUN npm run build

# 2) 运行时仍然只有 Python：镜像里不装 Node，也不需要 npm
FROM python:3.12-slim
WORKDIR /app
COPY app_server.py auth_security.py chart.py client_address.py ea_hub.py challenge_image.py journal.py market.py live.py local_ea.py sync_history.py trade_time.py bootstrap_admin.py ./
COPY web ./web
# 三个 EA 源码包都由 local_ea.py 从 bridge/ 现场打包（不存 zip），只拷 PRODUCTS 里用到的
# 入口、include 和说明/协议文档；少一个文件对应下载接口就是 503，不要让镜像漏文件。
COPY bridge/SyncNoteLocal.mq5 bridge/SyncNoteLocalJson.mqh bridge/SyncNoteLocalSocket.mqh \
     bridge/SyncNote.mq5 bridge/SyncTrade.mq5 bridge/SyncNoteHistory.mqh bridge/SyncNoteJson.mqh \
     bridge/LOCAL_README.md bridge/LOCAL_PROTOCOL.md \
     bridge/SyncNote_README.md bridge/SyncTrade_README.md bridge/SYNCNOTE_PROTOCOL.md ./bridge/
RUN rm -rf /app/web/chart-src /app/web/chart
COPY --from=chart /chart ./web/chart
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN chmod -R a+rX /app && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["python", "app_server.py"]
