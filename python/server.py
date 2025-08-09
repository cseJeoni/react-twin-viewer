# server.py
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import asyncio
import cv2
import numpy as np
import json
import yaml
from pathlib import Path

# ========= 경로/설정 =========
BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = (BASE_DIR / "../public").resolve()
MAP_IMAGE_DIR = (BASE_DIR / "../src/map_image").resolve()

# .pgm/.yaml 이름(확장자 제외)
MAP_FILE_NAME = "turtlebot3_burger_example_map"
PGM_PATH = MAP_IMAGE_DIR / f"{MAP_FILE_NAME}.pgm"
YAML_PATH = MAP_IMAGE_DIR / f"{MAP_FILE_NAME}.yaml"

ROTATE_CCW_90 = False      # 필요 시 True

# 추출 파라미터
CLOSE_KERNEL_SIZE = 5
CLOSE_ITER = 2
AREA_MIN_RATIO = 0.01
BORDER_TOL = 3
APPROX_EPS_RATIO = 0.012
WALL_THICKNESS = 6
OFFSET_PX = 5              # inner(내벽) 오프셋(px)

# ========= 외곽선 추출 =========
def extract_outer_contours(gray):
    # 1) 이진화: 벽=검정
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if (bw == 0).sum() < (bw == 255).sum():
        bw = cv2.bitwise_not(bw)

    # 2) 끊긴 벽 이어붙이기
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)

    # 3) 외곽 컨투어
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return contours

def generate_wall_and_meta():
    print("Generating map data...")
    if not PGM_PATH.exists():
        raise FileNotFoundError(f"PGM not found: {PGM_PATH}")
    if not YAML_PATH.exists():
        raise FileNotFoundError(f"YAML not found: {YAML_PATH}")

    with open(YAML_PATH, "r", encoding="utf-8") as f:
        yaml_meta = yaml.safe_load(f)
    resolution = float(yaml_meta.get("resolution", 0.05))
    origin_arr = yaml_meta.get("origin", [0.0, 0.0, 0.0])  # [x0,y0,theta]

    gray = cv2.imread(str(PGM_PATH), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(PGM_PATH)
    if ROTATE_CCW_90:
        gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)

    h, w = gray.shape

    # ---- 외벽 컨투어 중 가장 큰 것 선택
    contours = extract_outer_contours(gray)
    if not contours:
        raise RuntimeError("외벽 컨투어를 찾지 못했습니다.")
    # 테두리 네모/노이즈 제거 + 면적 기준 필터
    filtered = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if (x <= BORDER_TOL and y <= BORDER_TOL and
            w - (x + cw) <= BORDER_TOL and h - (y + ch) <= BORDER_TOL):
            continue
        filtered.append(c)
    if not filtered:
        filtered = contours

    areas = [cv2.contourArea(c) for c in filtered]
    if areas:
        max_area = max(areas)
        filtered = [c for c in filtered if cv2.contourArea(c) > AREA_MIN_RATIO * max_area]

    cnt = max(filtered, key=cv2.contourArea)
    eps = APPROX_EPS_RATIO * cv2.arcLength(cnt, True)
    outer = np.squeeze(cv2.approxPolyDP(cnt, eps, True)).astype(int)  # (N,2)

    # ---- inner: erode로 안쪽 오프셋
    mask = np.zeros((h, w), np.uint8)
    cv2.drawContours(mask, [cnt], -1, 255, thickness=cv2.FILLED)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*OFFSET_PX, 2*OFFSET_PX))
    eroded = cv2.erode(mask, ker)
    inner_cnts, _ = cv2.findContours(eroded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    inner = np.squeeze(inner_cnts[0]).astype(int) if inner_cnts else outer.copy()

    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    # wall_shell.json: { outer, inner }
    with open(PUBLIC_DIR / "wall_shell.json", "w", encoding="utf-8") as f:
        json.dump({"outer": outer.tolist(), "inner": inner.tolist()}, f)

    # meta.json: height 포함 + origin 객체화
    meta = {
        "width": w,
        "height": h,
        "resolution": resolution,
        "origin": {"x0": float(origin_arr[0]), "y0": float(origin_arr[1])},
        "rotateCCW90": ROTATE_CCW_90
    }
    with open(PUBLIC_DIR / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    # map_outline.png(눈검사용)
    canvas = np.full((h, w, 3), 255, np.uint8)
    cv2.drawContours(canvas, [cnt], -1, (0,0,0), WALL_THICKNESS)
    if ROTATE_CCW_90:
        canvas = cv2.rotate(canvas, cv2.ROTATE_90_COUNTERCLOCKWISE)
    cv2.imwrite(str(PUBLIC_DIR / "map_outline.png"), canvas)

    print("✔ saved public/wall_shell.json, meta.json, map_outline.png")

# ========= FastAPI =========
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

clients = set()

class Pose(BaseModel):
    x: float
    y: float

@app.post("/pose")
async def receive_pose(pose: Pose):
    # 그대로 x,y를 브로드캐스트 → 클라이언트에서 meta 기준으로 변환
    data = {"x": float(pose.x), "y": float(pose.y)}
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(data)
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

if __name__ == "__main__":
    try:
        generate_wall_and_meta()
    except Exception as e:
        import traceback; traceback.print_exc()
        input("ERROR above. Press Enter to exit...")

    print("Starting server on http://0.0.0.0:8000")
    print("WebSocket is available at ws://<서버IP>:8000/ws")
    uvicorn.run(app, host="0.0.0.0", port=8000)
