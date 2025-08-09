"""
slam_to_wall_shell_from_yaml.py
────────────────────────────────────────
고정 경로의 PGM + YAML → wall_shell.json + meta.json 생성
"""

import cv2
import numpy as np
import json
import yaml
from pathlib import Path

# ── 여기서 PGM, YAML 경로를 직접 지정 ───────────────
BASE_DIR = Path(__file__).resolve().parent
PGM_PATH = BASE_DIR / "../src/map_image/turtlebot3_burger_example_map.pgm"
YAML_PATH = BASE_DIR / "../src/map_image/turtlebot3_burger_example_map.yaml"


# ── 파라미터 ───────────────────────────────────────
CLOSE_KERNEL_SIZE  = 5
CLOSE_ITER         = 2
AREA_MIN_RATIO     = 0.01
BORDER_TOL         = 3
APPROX_EPS_RATIO   = 0.012
WALL_THICKNESS     = 6
ROTATE_CCW_90      = False   # 필요 시 True

def prettify(gray):
    h, w = gray.shape

    # Otsu 이진화 (벽=검정)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if (bw == 0).sum() < (bw == 255).sum():
        bw = cv2.bitwise_not(bw)

    # Closing
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)

    # 컨투어 추출
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    # 프레임 제거
    filtered = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if (x <= BORDER_TOL and y <= BORDER_TOL and
            w - (x + cw) <= BORDER_TOL and h - (y + ch) <= BORDER_TOL):
            continue
        filtered.append(c)

    if not filtered:
        filtered = contours

    # 작은 면적 제거
    areas = [cv2.contourArea(c) for c in filtered]
    if areas:
        max_area = max(areas)
        filtered = [c for c in filtered if cv2.contourArea(c) > AREA_MIN_RATIO * max_area]

    # 단순화 & JSON 변환 좌표
    wall_coords = []
    for c in filtered:
        eps = APPROX_EPS_RATIO * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        pts = approx.reshape(-1, 2).tolist()
        wall_coords.append(pts)

    return wall_coords, (h, w)

def main():
    # ── YAML 읽기 ──────────────────────────────
    with open(YAML_PATH, 'r') as f:
        meta_yaml = yaml.safe_load(f)

    resolution = float(meta_yaml.get("resolution", 0.05))
    origin = meta_yaml.get("origin", [0.0, 0.0, 0.0])
    rotate_flag = ROTATE_CCW_90

    # ── PGM 읽기 ───────────────────────────────
    gray = cv2.imread(str(PGM_PATH), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(PGM_PATH)

    if rotate_flag:
        gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)

    wall_coords, (h, w) = prettify(gray)

    # ── wall_shell.json 저장 ─────────────────────
    with open("wall_shell.json", "w") as f:
        json.dump(wall_coords, f)

    # ── meta.json 저장 ─────────────────────────
    meta = {
        "width": w,
        "height": h,
        "resolution": resolution,
        "origin": {"x0": origin[0], "y0": origin[1]},
        "rotateCCW90": rotate_flag
    }
    with open("meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"✔ wall_shell.json & meta.json 생성 완료 ({w}×{h}, res={resolution}, origin={origin})")

if __name__ == "__main__":
    main()
