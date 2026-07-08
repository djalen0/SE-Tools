FROM python:3.11-slim

WORKDIR /app

# pdfplumber pulls in Pillow/pypdfium2, which need a couple of system
# image libs on slim Debian bases; kept minimal on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo \
    zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Data dir holds the persisted shared job + prefs (data/current_job.json,
# data/prefs.json) and the color sidecar next to design.xlsx -- created here
# so it exists even before the app's first save, and so a mounted volume at
# this path (see DEPLOY.md) can persist across redeploys.
RUN mkdir -p /app/data

ENV PORT=8765
EXPOSE 8765

# gunicorn, not the Flask dev server -- single worker on purpose: the whole
# app is built around ONE shared in-process job (STATE['job']), so more than
# one worker process would mean multiple independent copies of that job
# silently diverging. If this ever needs to scale beyond one worker, the
# shared state has to move to a real datastore (Redis, a database, etc.)
# first -- see DEPLOY.md.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:8765", "app:app"]
