# Dockerfile (Final, Production-Ready Version with Playwright)

FROM python:3.11-slim-bookworm

# Install system dependencies including Playwright requirements
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    python3-dev \
    libffi-dev \
    libssl-dev \
    wget \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Playwright environment variables
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY python-backend/requirements.txt . 

RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers with dependencies
RUN playwright install --with-deps chromium

COPY python-backend/ . 

EXPOSE 8765

ENV PYTHONUNBUFFERED=1

# Railway will set PORT dynamically (usually 8000-9000 range)
# Gunicorn binds to 0.0.0.0:$PORT which Railway provides
# For local development, PORT defaults to 8765
# --log-level info: Enable logging for debugging
# --access-logfile -: Log access to stdout
# --error-logfile -: Log errors to stdout
CMD ["sh", "-c", "gunicorn --worker-class eventlet -w 1 --timeout 300 --keep-alive 65 --log-level info --access-logfile - --error-logfile - --bind 0.0.0.0:${PORT:-8765} app:app"]