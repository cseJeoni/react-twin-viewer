// src/components/ObstacleMesh.jsx
import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

const CONE_MODEL_PATH = 'cone.glb';

// [기존] 꼬깔콘 재질 설정 (변경 없음)
const coneMaterial = new THREE.MeshStandardMaterial({
  color: '#FFA500', 
  emissive: '#FF8C00',
  emissiveIntensity: 0.3,
  metalness: 0.1,
  roughness: 0.7,
});

// --- [신규] Point-in-Polygon 함수 ---
// 점(point)이 다각형(polygon) 내부에 있는지 확인하는 함수 (Ray-casting 알고리즘)
function isPointInPolygon(point, polygon) {
  const { x, y } = point;
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}


export default function ObstacleMesh({ data, coneScale = 2, coneHeightOffset = 0 }) {
  const { scene: coneSceneOriginal } = useGLTF(CONE_MODEL_PATH);

  // [기존] GLTF 모델 로드 및 재질 적용 (변경 없음)
  const coneScene = useMemo(() => {
    if (!coneSceneOriginal) return null;
    const clonedScene = coneSceneOriginal.clone();
    clonedScene.traverse((child) => {
      if (child.isMesh) {
        child.material = coneMaterial;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clonedScene;
  }, [coneSceneOriginal]);


  // --- [수정] 꼬깔콘 위치 계산 로직 ---
  const conePositions = useMemo(() => {
    if (!data || !Array.isArray(data.obstacles)) {
      return [];
    }
    
    // 꼬깔콘을 배치할 간격 (픽셀 단위, 이 값을 조절해 밀도를 변경)
    const coneSpacing = 10; 
    const allConePositions = [];

    data.obstacles.forEach(polygon => {
      if (!polygon || polygon.length < 3) return;

      // 1. 폴리곤의 바운딩 박스 계산
      let minX = Infinity, minY = Infinity;
      let maxX = -Infinity, maxY = -Infinity;
      polygon.forEach(([x, y]) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      });

      // 2. 바운딩 박스 내부에 격자를 생성하며 순회
      for (let x = minX; x <= maxX; x += coneSpacing) {
        for (let y = minY; y <= maxY; y += coneSpacing) {
          // 3. 현재 격자점이 폴리곤 내부에 있는지 확인
          if (isPointInPolygon({ x, y }, polygon)) {
            // 4. 내부에 있다면 꼬깔콘 위치 추가
            allConePositions.push(new THREE.Vector3(x, -y, coneHeightOffset));
          }
        }
      }
    });
    
    return allConePositions;
  }, [data, coneHeightOffset]);

  if (!coneScene || conePositions.length === 0) {
    return null;
  }

  // [기존] 렌더링 부분 (변경 없음)
  return (
    <group>
      {conePositions.map((pos, index) => (
        <primitive
          key={index}
          object={coneScene.clone()}
          position={pos}
          scale={[coneScale, coneScale, coneScale]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  );
}