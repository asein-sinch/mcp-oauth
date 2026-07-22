# Use official Python 3.10 slim image
FROM python:3.10-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies (git is required to install the A2UI package from github)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file first to leverage Docker cache
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Expose port 8080 (default for Cloud Run)
EXPOSE 8080

# Run the FastAPI server via uvicorn
CMD ["uvicorn", "sinch_messaging_agent_a2ui.local_tester.server:app", "--host", "0.0.0.0", "--port", "8080"]
