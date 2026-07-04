FROM python:3.11-alpine

# Install SSH client for uploading images to tw-nl via scp
RUN apk add --no-cache openssh-client ffmpeg

# Install Google Sheets API and HTTP/OAuth libraries
RUN pip install --no-cache-dir gspread google-auth requests requests-oauthlib telethon pillow

# Create workspace and data directory
WORKDIR /app
RUN mkdir -p /data

# Copy the app and shared core.
COPY posting/telegram_to_threads.py /app/
COPY posting/pipeline_metrics.py /app/
COPY posting/controller_bot.py /app/
COPY posting/capability_matrix.py /app/
COPY posting/control_plane.py /app/
COPY posting/app.py /app/
COPY posting_core /app/posting_core

# Set executable permission
RUN chmod +x /app/telegram_to_threads.py /app/controller_bot.py /app/capability_matrix.py /app/control_plane.py /app/app.py

# Run the script
CMD ["python", "-u", "/app/app.py"]
