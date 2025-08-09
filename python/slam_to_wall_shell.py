"""
slam_to_wall_shell.py
────────────────────────────────────────────────────────
1) SLAM 맵(PNG) → 외벽만 추출한 PNG 생성
2) 외벽 PNG → wall_shell.json 생성 (React public 폴더에 저장)

▶ pip install opencv-python numpy
▶ python slam_to_wall_shell.py
"""

import cv2
import numpy as np
import json
from pathlib import Path

# ======== 절대 경로 설정 ========
BASE_DIR = Path(__file__).resolve().parent.parent  # 프로젝트 루트
SRC = BASE_DIR / 'src' / 'map_image' / 'turtlebot3_burger_example_map.png'  # 원본 SLAM 이미지
OUTLINE_PNG = BASE_DIR / 'public' / 'turtlebot3_burger_example_map_outline.png'  # 외벽 PNG
OUTPUT_JSON = BASE_DIR / 'public' / 'wall_shell.json'  # React용 외벽/내벽 JSON
# ===============================

# 외벽 추출 파라미터
THRESH_METHOD      = cv2.THRESH_BINARY + cv2.THRESH_OTSU
CLOSE_KERNEL_SIZE  = 5
CLOSE_ITER         = 2
AREA_MIN_RATIO     = 0.01
BORDER_TOL         = 3
APPROX_EPS_RATIO   = 0.012
WALL_THICKNESS     = 6

# JSON 내벽 offset(px)
OFFSET = 5


def prettify(in_path: Path, out_path: Path):
    gray = cv2.imread(str(in_path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(in_path)
    h, w = gray.shape

    _, bw = cv2.threshold(gray, 0, 255, THRESH_METHOD)
    if (bw == 0).sum() < (bw == 255).sum():
        bw = cv2.bitwise_not(bw)

    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)

    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

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

    canvas = np.full((h, w, 3), 255, np.uint8)
    for c in filtered:
        eps = APPROX_EPS_RATIO * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        cv2.drawContours(canvas, [approx], -1, (0, 0, 0), WALL_THICKNESS)

    cv2.imwrite(str(out_path), canvas)
    print(f"✔ '{out_path}' 저장 — 외벽 {len(filtered)}개")
    return filtered, (h, w)


def export_wall_shell(contours, img_shape, output_json: Path):
    h, w = img_shape
    cnt = max(contours, key=cv2.contourArea)

    outer = np.squeeze(cnt).astype(int).tolist()

    mask = np.zeros((h, w), np.uint8)
    cv2.drawContours(mask, [cnt], -1, 255, thickness=cv2.FILLED)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*OFFSET, 2*OFFSET))
    eroded = cv2.erode(mask, kernel)

    inner_contours, _ = cv2.findContours(eroded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    inner = np.squeeze(inner_contours[0]).astype(int).tolist()

    with open(output_json, 'w') as f:
        json.dump({"outer": outer, "inner": inner}, f)

    print(f"✔ '{output_json}' 저장 — 외벽/내벽 좌표 완료")


if __name__ == "__main__":
    contours, shape = prettify(SRC, OUTLINE_PNG)
    export_wall_shell(contours, shape, OUTPUT_JSON)
