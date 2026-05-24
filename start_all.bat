@echo off
echo Starting AlgoTrade Backend...
cd backend
start cmd /k ".\venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo Starting AlgoTrade Frontend...
cd ../frontend
start cmd /k "npm run dev"

echo Both services are starting. Open browser at http://localhost:5173
