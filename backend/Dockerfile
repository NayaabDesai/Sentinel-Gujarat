FROM python:3.12-slim

WORKDIR /app

# System deps for asyncpg / psycopg native libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (layer cached unless requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1
ENV OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp

EXPOSE 8000

# --reload watches for code changes in development (safe to remove for prod)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
