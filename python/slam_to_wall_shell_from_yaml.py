# python/slam_to_wall_shell_from_yaml.py (수정된 버전)
import json
from pathlib import Path
import cv2
import numpy as np
import yaml

# ===== 경로/설정 =====================================================
# 이전에 수정한 파라미터들은 원래 값으로 되돌리는 것이 좋습니다.
BASE_DIR     = Path(__file__).resolve().parent
CONFIG_PATH  = (BASE_DIR.parent / "public" / "map-config.json").resolve()
OUTPUT_DIR   = (BASE_DIR.parent / "public").resolve()
OUT_WALL     = OUTPUT_DIR / "wall_shell.json"
OUT_META     = OUTPUT_DIR / "meta.json"
OUT_OBSTACLES = OUTPUT_DIR / "obstacles.json"

# ===== 외곽/윤곽 추출 파라미터 (기본값으로 복원 권장) ----------------
CLOSE_KERNEL_SIZE     = 5
CLOSE_ITER            = 2
AREA_MIN_RATIO        = 0.01
APPROX_EPS_RATIO      = 0.004
OBSTACLE_MIN_AREA_PX  = 30

# ----- 벽 두께(픽셀 단위) ------------------------------------------
DEFAULT_WALL_THICK_PX = 6.5

# ----- 회색 장애물 감지 임계값 -------------------------------
GRAY_THRESHOLD_LOW = 50
GRAY_THRESHOLD_HIGH = 220
# --------------------------------------------------------------------


# --- [변경됨] 새로운 바닥 추출 함수 ---
def extract_floor_inner(gray: np.ndarray):
    """
    '섬' 형태의 맵을 위해 로직을 변경합니다.
    Floodfill 방식 대신, 이미지에서 가장 밝은(흰색) 영역을 직접 찾습니다.
    """
    # 1. 거의 순수한 흰색(250-255)에 해당하는 픽셀만 선택하여 바닥 마스크를 생성합니다.
    #    SLAM 맵에서 바닥은 보통 가장 밝은 값을 가집니다.
    floor_mask = cv2.inRange(gray, 250, 255)
    
    # 2. 바닥 내부의 작은 검은색 노이즈나 구멍을 메우기 위해 모폴로지 연산을 수행합니다.
    #    이전 로직의 CLOSE_KERNEL_SIZE, CLOSE_ITER를 여기서 활용합니다.
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    floor_mask = cv2.morphologyEx(floor_mask, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)
    
    return floor_mask
# --- [여기까지 변경] ---


def load_config_profile(config_path: Path) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    profiles = cfg.get("profiles") or cfg.get("maps") or {}
    if not profiles: raise ValueError("map-config.json 에 profiles/maps 항목이 없습니다.")
    active = cfg.get("active")
    if not active or active not in profiles: active = next(iter(profiles))
    prof = profiles[active]
    wall_px = cfg.get("wall_px", DEFAULT_WALL_THICK_PX)
    prof["_wall_px_"] = int(wall_px)
    return prof

def resolve_from_config(path_str: str) -> Path:
    if not path_str: return None
    p = Path(path_str)
    return p if p.is_absolute() else (CONFIG_PATH.parent / p).resolve()

def parse_map_yaml(yaml_path: Path):
    with open(yaml_path, "r", encoding="utf-8") as f:
        y = yaml.safe_load(f)
    res = float(y.get("resolution", 0.05))
    origin = y.get("origin", [0.0, 0.0, 0.0])
    origin = [float(v) for v in origin]
    if len(origin) == 2: origin.append(0.0)
    image_rel = y.get("image")
    if not image_rel: raise ValueError("YAML에 'image' 항목이 없습니다.")
    image_path = (yaml_path.parent / image_rel).resolve()
    return res, origin, image_path

def approx_poly_from_contour(contour: np.ndarray, eps_ratio: float):
    eps = eps_ratio * cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, eps, True)
    return approx.reshape(-1, 2).astype(float).tolist()

def find_largest_polygon(mask: np.ndarray, eps_ratio: float, area_min_ratio: float):
    h, w = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours: return None
    main_contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(main_contour) < (h * w * area_min_ratio): return None
    return approx_poly_from_contour(main_contour, eps_ratio)

def find_gray_obstacles(gray_img: np.ndarray, floor_mask: np.ndarray, eps_ratio: float, min_area_px: float):
    gray_obstacle_mask = cv2.inRange(gray_img, GRAY_THRESHOLD_LOW, GRAY_THRESHOLD_HIGH)
    gray_inside_floor = cv2.bitwise_and(gray_obstacle_mask, floor_mask)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    cleaned_mask = cv2.morphologyEx(gray_inside_floor, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(cleaned_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    obstacles = []
    for contour in contours:
        if cv2.contourArea(contour) > min_area_px:
            poly = approx_poly_from_contour(contour, eps_ratio)
            if len(poly) >= 3:
                obstacles.append(poly)
    return obstacles

def find_hole_obstacles(mask: np.ndarray, eps_ratio: float, min_area_px: float):
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    obstacles = []
    if hierarchy is None: return obstacles
    for i, h in enumerate(hierarchy[0]):
        if h[3] != -1:
            contour = contours[i]
            if cv2.contourArea(contour) > min_area_px:
                poly = approx_poly_from_contour(contour, eps_ratio)
                if len(poly) >= 3:
                    obstacles.append(poly)
    return obstacles

def dilate_mask(mask: np.ndarray, px: int):
    if px <= 0: return mask.copy()
    k = 2 * px + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    return cv2.dilate(mask, kernel, iterations=1)

def main():
    try:
        prof = load_config_profile(CONFIG_PATH)
        if "yaml" in prof and prof["yaml"]:
            yaml_path = resolve_from_config(prof["yaml"])
            if not yaml_path.exists(): raise FileNotFoundError(f"YAML 파일을 찾을 수 없습니다: {yaml_path}")
            resolution, origin, img_path = parse_map_yaml(yaml_path)
        else:
            img_path   = resolve_from_config(prof.get("pgm") or prof.get("image") or prof.get("png", ""))
            resolution, origin = prof.get("resolution"), prof.get("origin")
            if not img_path or not img_path.exists(): raise FileNotFoundError(f"PGM/PNG 파일을 찾을 수 없습니다: {img_path}")
            if resolution is None or origin is None: raise ValueError("PGM/PNG 직접 지정 시 'resolution'과 'origin'이 필요합니다.")
            origin = [float(v) for v in origin]
            if len(origin) == 2: origin.append(0.0)

        gray = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
        if gray is None: raise FileNotFoundError(f"맵 이미지를 로드할 수 없습니다: {img_path}")

        floor_mask = extract_floor_inner(gray)
        inner_poly = find_largest_polygon(floor_mask, APPROX_EPS_RATIO, AREA_MIN_RATIO)
        if not inner_poly or len(inner_poly) < 3:
            raise RuntimeError("내부(floor) 폴리곤을 추출하지 못했습니다. 입력 맵/파라미터를 확인하세요.")

        wall_px = int(max(1, prof.get("_wall_px_", DEFAULT_WALL_THICK_PX)))
        outer_mask = dilate_mask(floor_mask, wall_px)
        outer_poly = find_largest_polygon(outer_mask, APPROX_EPS_RATIO, AREA_MIN_RATIO)
        if not outer_poly or len(outer_poly) < 3:
            raise RuntimeError("outer 폴리곤을 생성하지 못했습니다.")

        print("\n장애물 추출 중...")
        hole_obstacles = find_hole_obstacles(floor_mask, APPROX_EPS_RATIO, OBSTACLE_MIN_AREA_PX)
        gray_obstacles = find_gray_obstacles(gray, floor_mask, APPROX_EPS_RATIO, OBSTACLE_MIN_AREA_PX)
        obstacle_polys = hole_obstacles + gray_obstacles
        print(f"  - 검은 구멍: {len(hole_obstacles)}개 / 회색 영역: {len(gray_obstacles)}개")
        print(f"  → 총 장애물: {len(obstacle_polys)}개")

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        with open(OUT_WALL, "w", encoding="utf-8") as f:
            json.dump({"outer": outer_poly, "inner": inner_poly, "wall_px": wall_px}, f, ensure_ascii=False)
        with open(OUT_OBSTACLES, "w", encoding="utf-8") as f:
            json.dump({"obstacles": obstacle_polys}, f, ensure_ascii=False)
        meta = { "width": int(gray.shape[1]), "height": int(gray.shape[0]), "resolution": float(resolution), "origin": origin, "rotateCCW90": False }
        with open(OUT_META, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

        print("\n✔ 생성 완료")
        print(f"  obstacles.json 에 {len(obstacle_polys)}개 장애물 저장 완료")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\nERROR: {e}")

if __name__ == "__main__":
    main()