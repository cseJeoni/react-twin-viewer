// src/components/ObstacleMesh.jsx
import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

const CONE_MODEL_PATH = 'cone.glb';

// [추가] 꼬깔콘 색상 및 재질 설정
const coneMaterial = new THREE.MeshStandardMaterial({
  color: '#FFA500', // 주황색 (Hex 값)
  emissive: '#FF8C00', // 약간 밝은 주황색 발광
  emissiveIntensity: 0.3,
  metalness: 0.1,
  roughness: 0.7,
});

export default function ObstacleMesh({ data, coneScale = 3, coneHeightOffset = 0 }) {
  const { scene: coneSceneOriginal } = useGLTF(CONE_MODEL_PATH);

  // useMemo를 사용하여 coneSceneOriginal이 변경될 때만 자식 메쉬에 재질을 적용
  const coneScene = useMemo(() => {
    if (!coneSceneOriginal) return null;

    const clonedScene = coneSceneOriginal.clone(); // 원본 씬을 복제하여 작업

    // 복제된 씬의 모든 메쉬 자식 요소에 재질 적용
    clonedScene.traverse((child) => {
      if (child.isMesh) {
        child.material = coneMaterial; // 위에 정의한 재질 적용
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clonedScene;
  }, [coneSceneOriginal]);


  const conePositions = useMemo(() => {
    if (!data || !Array.isArray(data.obstacles)) {
      return [];
    }
    return data.obstacles.map(polygon => {
      if (!polygon || polygon.length < 3) return null;

      let minX = Infinity, minY = Infinity;
      let maxX = -Infinity, maxY = -Infinity;

      polygon.forEach(([x, y]) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      });

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      
      return new THREE.Vector3(centerX, -centerY, coneHeightOffset);
    }).filter(Boolean);
  }, [data, coneHeightOffset]);

  if (!coneScene || conePositions.length === 0) {
    return null;
  }

  return (
    <group>
      {conePositions.map((pos, index) => (
        <primitive
          key={index}
          object={coneScene.clone()} // 매 렌더링마다 복제하여 다른 위치에 배치
          position={pos}
          scale={[coneScale, coneScale, coneScale]}
          rotation={[Math.PI / 2, 0, 0]} // <--- [수정] X축을 기준으로 90도(PI/2 라디안) 회전하여 세움
          castShadow
          receiveShadow
        />
      ))}
    </group>
  );
}