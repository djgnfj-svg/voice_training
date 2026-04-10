FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Create non-root user
RUN addgroup --system app && adduser --system --ingroup app app

# Copy application code
COPY app/ app/

# Create audio storage directory with correct permissions
RUN mkdir -p .audio-storage && chown app:app .audio-storage

# Switch to non-root user
USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
