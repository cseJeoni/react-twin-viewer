"""
slam_to_wall_shell_from_yaml.py  (Reworked)
────────────────────────────────────────────
- public/map-config.json 의 active 프로필을 읽어 YAML/PGM 정보를 파싱
- SLAM 그레이 이미지로부터 방 "내부(floor)" 윤곽(=inner)을 robust 하게 추출
- inner 를 픽셀 단위로 팽창(dilate)하여 균일 두께의 outer 를 생성
- 결과를 public/wall_shell.json({outer,inner}) 과 public/meta.json 으로 저장

설계 포인트
- 기존 버전은 outer 가 단순 바운딩박스라 벽 두께가 일정하지 않고 "파인" 느낌이 남
- 본 버전은 내부 윤곽을 먼저 구한 뒤, 그 윤곽을 일정 픽셀만큼 바깥쪽으로 버퍼링(팽창)하여
  outer 를 만들어, 어느 곳에서든 동일한 벽 두께를 보장
"""

import json
from pathlib import Path
import cv2
import numpy as np
import yaml

# ===== 경로/설정 =====================================================
BASE_DIR     = Path(__file__).resolve().parent             # ./python
CONFIG_PATH  = (BASE_DIR.parent / "public" / "map-config.json").resolve()
OUTPUT_DIR   = (BASE_DIR.parent / "public").resolve()
OUT_WALL     = OUTPUT_DIR / "wall_shell.json"
OUT_META     = OUTPUT_DIR / "meta.json"
# ====================================================================

# ----- 외곽/윤곽 추출 파라미터 --------------------------------------
CLOSE_KERNEL_SIZE  = 5       # 벽 틈 메움
CLOSE_ITER         = 2
AREA_MIN_RATIO     = 0.01    # 너무 작은 노이즈 제거
APPROX_EPS_RATIO   = 0.004   # 도형 근사 (작을수록 디테일 up)

# ----- 벽 두께(픽셀 단위) ------------------------------------------
#  - 이미지 좌표계에서의 벽 두께(px). 실제 미터 두께는 thickness_m = thickness_px * resolution
#  - 필요 시 public/map-config.json 에 "wall_px": 8 처럼 넣어 덮어쓸 수 있음.
DEFAULT_WALL_THICK_PX = 6.5
# --------------------------------------------------------------------


def load_config_profile(config_path: Path) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    profiles = cfg.get("profiles") or cfg.get("maps") or {}
    if not profiles:
        raise ValueError("map-config.json 에 profiles/maps 항목이 없습니다.")
    active = cfg.get("active")
    if not active or active not in profiles:
        active = next(iter(profiles))
    prof = profiles[active]
    # 선택적 wall_px
    wall_px = cfg.get("wall_px", DEFAULT_WALL_THICK_PX)
    prof["_wall_px_"] = int(wall_px)
    return prof


def resolve_from_config(path_str: str) -> Path:
    if not path_str:
        return None
    p = Path(path_str)
    return p if p.is_absolute() else (CONFIG_PATH.parent / p).resolve()


def parse_map_yaml(yaml_path: Path):
    with open(yaml_path, "r", encoding="utf-8") as f:
        y = yaml.safe_load(f)
    res = float(y.get("resolution", 0.05))
    origin = y.get("origin", [0.0, 0.0, 0.0])
    if isinstance(origin, (list, tuple)):
        if len(origin) == 2:
            origin = [float(origin[0]), float(origin[1]), 0.0]
        else:
            origin = [float(origin[0]), float(origin[1]), float(origin[2])]
    else:
        origin = [0.0, 0.0, 0.0]
    image_rel = y.get("image")
    if not image_rel:
        raise ValueError("YAML에 'image' 항목이 없습니다.")
    image_path = (yaml_path.parent / image_rel).resolve()
    return res, origin, image_path


def approx_poly_from_mask(mask: np.ndarray, eps_ratio: float, area_min_ratio: float):
    """
    흰색(255) 영역의 외곽선(contour) → 근사 폴리곤(가장 큰 것 1개)
    반환: list[[x,y], ...]  (이미지 좌표계: 원점 좌상단, x→오른쪽+, y→아래쪽+)
    """
    h, w = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    # 면적 기준 필터
    areas = [cv2.contourArea(c) for c in contours]
    max_area = max(areas)
    keep = [c for c in contours if cv2.contourArea(c) > area_min_ratio * max_area]
    if not keep:
        keep = [contours[int(np.argmax(areas))]]
    # 가장 큰 것 1개
    idx = int(np.argmax([cv2.contourArea(c) for c in keep]))
    c = keep[idx]
    eps = eps_ratio * cv2.arcLength(c, True)
    approx = cv2.approxPolyDP(c, eps, True)
    pts = approx.reshape(-1, 2).astype(float).tolist()
    return pts


def extract_floor_inner(gray: np.ndarray):
    """
    SLAM gray → '방 내부(floor)' 영역 마스크(255) 생성
    - 벽/가구 등 장애물은 0, 내부는 255
    - 외부(이미지 경계에 닿는 영역)는 flood fill로 제거
    """
    # 1) Otsu 이진화
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # 2) 벽이 검정(0)이 되도록 필요시 반전
    if (bw == 0).sum() < (bw == 255).sum():
        bw = cv2.bitwise_not(bw)
    # 3) Closing 으로 벽 구멍/틈 메움
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)
    # 현재: 흰색=바닥/외부, 검정=벽

    # 4) 외부 제거: 경계에서 flood-fill 하여 외부 흰색을 128로 마킹
    h, w = bw.shape
    tmp = bw.copy()
    ffmask = np.zeros((h+2, w+2), np.uint8)
    # 네 변을 따라 흰색이면 flood-fill
    for x in range(w):
        if tmp[0, x] == 255:     cv2.floodFill(tmp, ffmask, (x, 0),   128)
        if tmp[h-1, x] == 255:   cv2.floodFill(tmp, ffmask, (x, h-1), 128)
    for y in range(h):
        if tmp[y, 0] == 255:     cv2.floodFill(tmp, ffmask, (0, y),   128)
        if tmp[y, w-1] == 255:   cv2.floodFill(tmp, ffmask, (w-1, y), 128)

    # 내부만 255로 남기기
    floor_mask = np.where(tmp == 255, 255, 0).astype(np.uint8)
    return floor_mask


def dilate_mask(mask: np.ndarray, px: int):
    if px <= 0:
        return mask.copy()
    k = 2*px + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    return cv2.dilate(mask, kernel, iterations=1)


def main():
    # 1) 프로필 로드
    prof = load_config_profile(CONFIG_PATH)

    # 2) 입력 소스 결정
    if "yaml" in prof and prof["yaml"]:
        yaml_path = resolve_from_config(prof["yaml"])
        if not yaml_path.exists():
            raise FileNotFoundError(f"YAML 파일을 찾을 수 없습니다: {yaml_path}")
        resolution, origin, img_path = parse_map_yaml(yaml_path)
    else:
        img_path   = resolve_from_config(prof.get("pgm") or prof.get("image") or prof.get("png", ""))
        resolution = prof.get("resolution", None)
        origin     = prof.get("origin", None)
        if not img_path or not img_path.exists():
            raise FileNotFoundError(f"PGM/PNG 파일을 찾을 수 없습니다: {img_path}")
        if resolution is None or origin is None:
            raise ValueError("PGM/PNG 직접 지정 시 'resolution'과 'origin[x,y,theta]'가 필요합니다.")
        if isinstance(origin, (list, tuple)):
            if len(origin) == 2:
                origin = [float(origin[0]), float(origin[1]), 0.0]
            else:
                origin = [float(origin[0]), float(origin[1]), float(origin[2])]
        else:
            raise ValueError("origin 형식이 올바르지 않습니다. 예) [-2.06, -6.84, 0.0]")

    # 3) 이미지 로드
    gray = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(f"맵 이미지를 로드할 수 없습니다: {img_path}")

    # 4) 내부(floor) 마스크와 폴리곤(=inner) 추출
    floor_mask = extract_floor_inner(gray)
    inner_poly = approx_poly_from_mask(floor_mask, APPROX_EPS_RATIO, AREA_MIN_RATIO)
    if not inner_poly or len(inner_poly) < 3:
        raise RuntimeError("내부(floor) 폴리곤을 추출하지 못했습니다. 입력 맵/파라미터를 확인하세요.")

    # 5) 균일 두께의 outer 생성: floor_mask 를 wall_px 만큼 팽창 후 외곽선 추출
    wall_px = int(max(1, prof.get("_wall_px_", DEFAULT_WALL_THICK_PX)))
    outer_mask = dilate_mask(floor_mask, wall_px)
    outer_poly = approx_poly_from_mask(outer_mask, APPROX_EPS_RATIO, AREA_MIN_RATIO)
    if not outer_poly or len(outer_poly) < 3:
        raise RuntimeError("outer 폴리곤을 생성하지 못했습니다. wall_px 값을 조정하세요.")

    # 6) 저장
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(OUT_WALL, "w", encoding="utf-8") as f:
        json.dump({
            "outer": outer_poly,
            "inner": inner_poly,
            "wall_px": wall_px
        }, f, ensure_ascii=False)

    meta = {
        "width": int(gray.shape[1]),
        "height": int(gray.shape[0]),
        "resolution": float(resolution),
        "origin": [float(origin[0]), float(origin[1]), float(origin[2])],
        # 시각화/정합 보정용 선택 파라미터(옵션)
        "rotateCCW90": False
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print("✔ 생성 완료")
    print(f"  wall_shell.json → {OUT_WALL}")
    print(f"  meta.json       → {OUT_META}")
    print(f"  size = {meta['width']}x{meta['height']}, res = {resolution}, origin = {origin}")
    print(f"  wall_px = {wall_px}")
    print(f"  src  = {img_path}")


if __name__ == "__main__":
    main()