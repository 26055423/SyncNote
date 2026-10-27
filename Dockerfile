FROM python:3.12-slim
WORKDIR /app
COPY app_server.py auth_security.py client_address.py challenge_image.py journal.py market.py trade_time.py bootstrap_admin.py ./
COPY web ./web
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN chmod -R a+rX /app && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["python", "app_server.py"]
