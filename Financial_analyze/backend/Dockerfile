FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# NOTE: requirements.txt pins vnstock==4.0.4, which is no longer published on
# PyPI. This build fails unless a local vnstock-4.0.4 wheel is copied in and
# installed first (e.g. COPY wheels/ /wheels/ and
# pip install --find-links /wheels -r requirements.txt). Not fixed here.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY alembic.ini .
COPY alembic ./alembic

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
