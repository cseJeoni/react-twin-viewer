"""
slam_to_wall_shell_from_yaml.py
────────────────────────────────────────
사용법:  python slam_to_wall_shell_from_yaml.py    (인자 없음)

- public/map-config.json 의 active 프로필을 읽어
  - (A) "yaml": "maps/xxx.yaml"  이면 YAML에서 image/resolution/origin 파싱
  - (B) "pgm":  "maps/xxx.pgm" + "resolution", "origin" 이면 그대로 사용
- 경로는 모두 **map-config.json이 있는 폴더 기준**의 상대경로로 해석
- 결과는 public/ 에 wall_shell.json, meta.json 생성
"""

import json
from pathlib import Path
import cv2
import numpy as np
import yaml

# ===== 경로/설정 (프로젝트에 맞게 한 번만 수정) ==========================
BASE_DIR     = Path(__file__).resolve().parent          # ./python
CONFIG_PATH  = (BASE_DIR.parent / "public" / "map-config.json").resolve()
OUTPUT_DIR   = (BASE_DIR.parent / "public").resolve()
OUT_WALL     = OUTPUT_DIR / "wall_shell.json"
OUT_META     = OUTPUT_DIR / "meta.json"
# ======================================================================

# ----- 외곽 추출 파라미터(필요시 조정) -----
CLOSE_KERNEL_SIZE  = 4      # 3 → 4: 벽 구멍을 메우면서도 디테일 보존
CLOSE_ITER         = 2      # 1 → 2: 벽 내부 구멍을 확실히 메우기 위해 복원
AREA_MIN_RATIO     = 0.008  # 0.005 → 0.008: 너무 작은 노이즈 제거
BORDER_TOL         = 3
APPROX_EPS_RATIO   = 0.006  # 0.004 → 0.006: 디테일과 안정성의 균형
# -------------------------------------------


def load_config_profile(config_path: Path) -> dict:
    """map-config.json에서 active 프로필을 반환"""
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    profiles = cfg.get("profiles") or cfg.get("maps") or {}
    if not profiles:
        raise ValueError("map-config.json 에 profiles/maps 항목이 없습니다.")
    active = cfg.get("active")
    if not active or active not in profiles:
        # active 누락 시 첫 프로필 사용
        active = next(iter(profiles))
    return profiles[active]


def resolve_from_config(path_str: str) -> Path:
    """config 파일이 있는 폴더를 기준으로 상대경로를 절대경로로 변환"""
    if not path_str:
        return None
    p = Path(path_str)
    return p if p.is_absolute() else (CONFIG_PATH.parent / p).resolve()


def parse_map_yaml(yaml_path: Path):
    """YAML에서 resolution, origin, image 경로(절대) 반환"""
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


def poly_area(pts):
    """Shoelace formula"""
    if len(pts) < 3:
        return 0.0
    arr = np.asarray(pts, dtype=np.float64)
    x = arr[:, 0]; y = arr[:, 1]
    return float(0.5 * np.abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def prettify(gray: np.ndarray):
    """
    OccupancyGrid 그레이 이미지 → 외곽 폴리곤 리스트
    반환: (polygons: list[list[[x,y],...]] , (h, w))
    """
    h, w = gray.shape

    # Otsu 이진화
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # 벽(장애물)이 검정(0)이 되도록 필요시 반전
    if (bw == 0).sum() < (bw == 255).sum():
        bw = cv2.bitwise_not(bw)

    # Closing
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE))
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kern, iterations=CLOSE_ITER)

    # 컨투어
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    

    # 테두리 프레임 제거
    filtered = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if (x <= BORDER_TOL and y <= BORDER_TOL and
            w - (x + cw) <= BORDER_TOL and h - (y + ch) <= BORDER_TOL):
            continue
        filtered.append(c)
    if not filtered:
        filtered = contours

    # 작은 면적 제거(최대 외곽 대비)
    if filtered:
        areas = [cv2.contourArea(c) for c in filtered]
        max_area = max(areas)
        filtered = [c for c in filtered if cv2.contourArea(c) > AREA_MIN_RATIO * max_area]

    # 근사 폴리곤
    polys = []
    for c in filtered:
        eps = APPROX_EPS_RATIO * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        pts = approx.reshape(-1, 2).astype(float).tolist()
        polys.append(pts)

    return polys, (h, w)


def main():
    # 1) 프로필 로드
    prof = load_config_profile(CONFIG_PATH)

    # 2) 입력 소스 결정: (A) yaml or (B) pgm+params
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

    # 3) 이미지 로드 (회전은 하지 않음; 좌표 회전은 origin[2]로 처리)
    gray = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(f"맵 이미지를 로드할 수 없습니다: {img_path}")

    # 4) 외곽 추출
    polys, (h, w) = prettify(gray)
    if not polys:
        raise RuntimeError("외곽 폴리곤을 추출하지 못했습니다. 파라미터를 조정하세요.")

    # 5) 저장 (public/)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(OUT_WALL, "w", encoding="utf-8") as f:
        json.dump(polys, f, ensure_ascii=False)

    meta = {
        "width": int(w),
        "height": int(h),
        "resolution": float(resolution),
        "origin": [float(origin[0]), float(origin[1]), float(origin[2])]
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print("✔ 생성 완료")
    print(f"  wall_shell.json → {OUT_WALL}")
    print(f"  meta.json       → {OUT_META}")
    print(f"  size = {w}x{h}, res = {resolution}, origin = {origin}")
    print(f"  src  = {img_path}")


if __name__ == "__main__":
    main()
