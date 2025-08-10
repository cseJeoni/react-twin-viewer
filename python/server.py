# server.py
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import asyncio
import subprocess
import sys
import os
from pathlib import Path

# ---- Windows WebSocket 이슈 예방(3.10+) ----
if os.name == "nt":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

BASE_DIR = Path(__file__).resolve().parent  # ./python

# ================== 생성 스크립트 호출 ==================
def generate_wall_and_meta():
    print("Generating map data via slam_to_wall_shell_from_yaml.py ...")
    gen = BASE_DIR / "slam_to_wall_shell_from_yaml.py"
    if not gen.exists():
        raise FileNotFoundError(f"Generator not found: {gen}")

    env = os.environ.copy()
    # 윈도우 콘솔에서 유니코드 출력 깨짐 방지
    env["PYTHONIOENCODING"] = "utf-8"

    proc = subprocess.run(
        [sys.executable, str(gen)],
        cwd=str(BASE_DIR),
        env=env,
        capture_output=True,
        text=True
    )

    # 생성 로그 보여주기
    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.returncode != 0:
        if proc.stderr:
            print(proc.stderr.rstrip())
        raise RuntimeError(f"Map generator failed with code {proc.returncode}")

    print("Map data generated (public/wall_shell.json, public/meta.json).")

# ================== FastAPI ==================
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

clients = set()

class Pose(BaseModel):
    x: float
    y: float

@app.post("/pose")
async def receive_pose(pose: Pose):
    msg = {"x": float(pose.x), "y": float(pose.y)}
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)
    return {"ok": True}

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    print(f"[ws] client connected ({len(clients)})")
    try:
        while True:
            await asyncio.sleep(60)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)
        print(f"[ws] client disconnected ({len(clients)})")

@app.get("/ping")
def ping():
    return {"ok": True}

def main():
    try:
        generate_wall_and_meta()
    except Exception:
        import traceback
        traceback.print_exc()
        input("ERROR above. Press Enter to exit...")
        sys.exit(1)

    # 🔽 여기서부터는 블로킹: 프로세스가 계속 살아있음
    host = "0.0.0.0"
    port = 8000
    print(f"Starting server on http://{host}:{port}")
    print("WebSocket: ws://<서버IP>:8000/ws")
    uvicorn.run(app, host=host, port=port, log_level="info")

if __name__ == "__main__":
    main()
