FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ble_battery_simulator.py .
EXPOSE 9101
CMD ["python", "ble_battery_simulator.py"]
