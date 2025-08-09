"""
slam_to_wall_shell_from_pgm.py
────────────────────────────────────────────
입력:
  - map.pgm (SLAM 점유맵) ← 필수
출력(public/에 저장):
  - map_outline.png    : 외벽만 그린 PNG
  - wall_shell.json    : Extrude용 outer/inner 경로 (픽셀 단위)
  - meta.json          : resolution, origin, width, height, rotateCCW90
"""

import cv2
import numpy as np
import json
from pathlib import Path

# ======== 경로 설정 ========
BASE_DIR = Path(__file__).resolve().parent.parent  # react 프로젝트 루트
PGM_PATH = BASE_DIR / 'src' / 'map_image' / 'turtlebot3_burger_example_map.pgm'

OUT_PUBLIC = BASE_DIR / 'public'
OUTLINE_PNG = OUT_PUBLIC / 'map_outline.png'
SHELL_JSON  = OUT_PUBLIC / 'wall_shell.json'
META_JSON   = OUT_PUBLIC / 'meta.json'

# ======== 메타 기본값 ========
RESOLUTION = 0.05               # m/px
ORIGIN = {"x0": 0.0, "y0": 0.0} # meters
ROTATE_CCW_90 = True            # PNG/JSON 저장 시 회전 여부

# ======== 외벽 추출 파라미터 ========
THRESH_METHOD      = cv2.THRESH_BINARY + cv2.THRESH_OTSU
CLOSE_KERNEL_SIZE  = 5
CLOSE_ITER         = 2
AREA_MIN_RATIO     = 0.01
BORDER_TOL         = 3
APPROX_EPS_RATIO   = 0.012
WALL_THICKNESS     = 6
OFFSET_PX          = 5  # inner offset
# ====================================

def extract_outer_contours(gray: np.ndarray):
    """ 흑백(SLAM PGM) → 외벽 컨투어 """
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

    approx_list = []
    for c in filtered:
        eps = APPROX_EPS_RATIO * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        approx_list.append(approx)

    return approx_list, (h, w)

def write_outline_png(contours, shape, out_path: Path):
    h, w = shape
    canvas = np.full((h, w, 3), 255, np.uint8)
    cv2.drawContours(canvas, contours, -1, (0, 0, 0), WALL_THICKNESS)

    if ROTATE_CCW_90:
        canvas = cv2.rotate(canvas, cv2.ROTATE_90_COUNTERCLOCKWISE)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), canvas)
    print(f"✔ saved outline: {out_path}")

def compute_shell_json(contours, shape, out_json: Path):
    h, w = shape
    cnt = max(contours, key=cv2.contourArea)
    outer = np.squeeze(cnt).astype(int)

    mask = np.zeros((h, w), np.uint8)
    cv2.drawContours(mask, [cnt], -1, 255, thickness=cv2.FILLED)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*OFFSET_PX, 2*OFFSET_PX))
    eroded = cv2.erode(mask, kernel)

    inner_contours, _ = cv2.findContours(eroded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not inner_contours:
        inner = outer.copy()
    else:
        inner = np.squeeze(inner_contours[0]).astype(int)

    if ROTATE_CCW_90:
        def rot_pts(pts):
            xs = pts[:, 0].astype(np.int32)
            ys = pts[:, 1].astype(np.int32)
            x_p = ys
            y_p = (w - 1 - xs)
            return np.stack([x_p, y_p], axis=1)
        outer = rot_pts(outer)
        inner = rot_pts(inner)
        new_w, new_h = h, w
        w, h = new_w, new_h

    data = {
        "outer": outer.tolist(),
        "inner": inner.tolist()
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    print(f"✔ saved shell json: {out_json}")
    return (h, w)

def main():
    gray = cv2.imread(str(PGM_PATH), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(PGM_PATH)

    contours, shape = extract_outer_contours(gray)
    write_outline_png(contours, shape, OUTLINE_PNG)
    final_h, final_w = compute_shell_json(contours, shape, SHELL_JSON)

    meta_out = {
        "resolution": RESOLUTION,
        "origin": ORIGIN,
        "width": final_w,
        "height": final_h,
        "rotateCCW90": ROTATE_CCW_90
    }
    with open(META_JSON, 'w', encoding='utf-8') as f:
        json.dump(meta_out, f)
    print(f"✔ saved meta json: {META_JSON}\n{meta_out}")

if __name__ == "__main__":
    main()
