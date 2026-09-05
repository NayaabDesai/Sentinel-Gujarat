FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY capture_worker.py .

ENV PYTHONUNBUFFERED=1
ENV OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp

CMD ["python", "-u", "capture_worker.py"]
