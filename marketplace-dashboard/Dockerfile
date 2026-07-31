# Use official lightweight Python image
FROM python:3.10-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Set working directory inside the container
WORKDIR /app

# Copy dependency specifications and install them
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files and folders into container
COPY templates/ /app/templates/
COPY main.py slack.py procurement.py /app/

# Expose server port
EXPOSE 8080

# Command to run uvicorn server on container boot
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
