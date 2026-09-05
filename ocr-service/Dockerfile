# PaddleOCR sidecar. Debian slim rather than Alpine: paddlepaddle ships manylinux
# wheels built against glibc, and there is no musl build to install on Alpine.
FROM python:3.11-slim

# libgomp1 - paddle's OpenMP runtime, loaded at import.
# libglib2.0-0 - still required by opencv-python-headless despite the name.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bake the models into the image. Without this the first scan after a deploy
# pays a multi-minute download, and an air-gapped deployment never works at all.
RUN python -c "from ocr_engine import Engine; Engine().warmup()"

# Models are loaded at boot, so the container is either ready or not - a cold
# first request never silently takes 40 seconds.
ENV PADDLE_WARMUP=1 PADDLE_LANGS=en,devanagari
EXPOSE 8100

# Bound to all interfaces so the API container can reach it over the compose
# network; it is NOT published to the host in docker-compose.yml.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
