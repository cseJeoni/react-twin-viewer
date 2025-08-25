// src/components/PoseMarker3D.jsx
import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

// 생성: 빨간 원형 그라디언트 텍스처(스프라이트용)
function useRadialTexture() {
  return useMemo(() => {
    const size = 256
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2)
    g.addColorStop(0.0, 'rgba(255,0,0,1.0)')
    g.addColorStop(0.35, 'rgba(255,0,0,0.35)')
    g.addColorStop(1.0, 'rgba(255,0,0,0.0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    tex.needsUpdate = true
    return tex
  }, [])
}

/**
 * PoseMarker3D
 * - 작은 코어 구
 * - 카메라를 향하는 glow 스프라이트(2D 오버레이 느낌)
 * - 바닥에 퍼지는 pulse ring
 * - (선택) 잔상: 최근 위치들을 희미한 스프라이트로 남김
 */
export default function PoseMarker3D({
  position = [0, 0, 6],
  coreRadius = 2.2,
  haloWorldSize = 32,   // 스프라이트 크기(월드단위; 직교카메라 zoom에 따라 커짐/작아짐)
  ringRadius = 9,       // 링 시작 반지름(월드단위, 픽셀 좌표계)
  ringThickness = 1.2,
  ringSpeed = 1.3,
  enableAfterimage = true,
  afterimageCount = 8,
  afterimageFadePerSec = 0.9, // 초당 투명도 감소
}) {
  const haloTex = useRadialTexture()

  // ── Pulse Ring ────────────────────────────────────────────
  const ringRef = useRef()
  const ringMatRef = useRef()
  useFrame((_, dt) => {
    if (!ringRef.current || !ringMatRef.current) return
    // scale.x === scale.y 로 동심원 확대
    const s = ringRef.current.scale.x + dt * ringSpeed
    if (s > 2.6) { // 한 바퀴 돌면 리셋
      ringRef.current.scale.setScalar(1)
    } else {
      ringRef.current.scale.setScalar(s)
    }
    // 중심에서 멀어질수록 투명하게
    const t = (ringRef.current.scale.x - 1) / 1.6
    ringMatRef.current.opacity = 0.85 * (1 - THREE.MathUtils.clamp(t, 0, 1))
  })

  // ── Afterimage(잔상) ───────────────────────────────────────
  const ghosts = useRef([]) // { sprite, life } 의 고정 길이 풀
  const ghostIndex = useRef(0)
  const ghostLayerRef = useRef()

  // 풀 초기화
  useEffect(() => {
    if (!ghostLayerRef.current) return
    const group = ghostLayerRef.current
    if (ghosts.current.length === 0) {
      for (let i = 0; i < afterimageCount; i++) {
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
          map: haloTex,
          color: new THREE.Color(1, 1, 1),
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }))
        spr.scale.set(haloWorldSize * 0.65, haloWorldSize * 0.65, 1)
        group.add(spr)
        ghosts.current.push({ sprite: spr, life: 0 })
      }
    }
  }, [haloTex, afterimageCount, haloWorldSize])

  // 새 포즈가 오면 잔상 하나를 현재 위치에 생성
  const lastKeyRef = useRef('')
  useEffect(() => {
    const key = position ? `${position[0].toFixed(2)}_${position[1].toFixed(2)}` : ''
    if (!position || key === lastKeyRef.current || ghosts.current.length === 0) return
    lastKeyRef.current = key
    const idx = ghostIndex.current % ghosts.current.length
    ghostIndex.current = idx + 1
    const g = ghosts.current[idx]
    g.life = 1.0
    g.sprite.position.set(position[0], position[1], (position[2] || 0) + 0.2)
    g.sprite.material.opacity = 0.45
  }, [position])

  // 잔상 페이드
  useFrame((_, dt) => {
    if (!enableAfterimage) return
    for (const g of ghosts.current) {
      if (g.life > 0) {
        g.life -= dt * afterimageFadePerSec
        g.sprite.material.opacity = Math.max(0, g.life) * 0.45
      }
    }
  })

  return (
    <group>
      {/* 잔상 레이어 (캔버스 루트 좌표 기준) */}
      <group ref={ghostLayerRef} />

      {/* 현재 포즈 */}
      <group position={position}>
        {/* Core sphere (작고 진하게) */}
        <mesh>
          <sphereGeometry args={[coreRadius, 24, 24]} />
          <meshStandardMaterial
            color="#ff4444"
            emissive="#ff2222"
            emissiveIntensity={0.5}
            metalness={0}
            roughness={0.3}
          />
        </mesh>

        {/* 카메라를 향하는 glow 스프라이트 */}
        <sprite scale={[haloWorldSize, haloWorldSize, 1]}>
          <spriteMaterial
            map={haloTex}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            color="white"
          />
        </sprite>

        {/* 바닥 pulse ring: XY 평면(기본), z=+0.2로 살짝 띄우기 */}
        <mesh ref={ringRef} position={[0, 0, 0.2]}>
          <ringGeometry args={[ringRadius, ringRadius + ringThickness, 64]} />
          <meshBasicMaterial
            ref={ringMatRef}
            color="#ff4d4d"
            transparent
            opacity={0.8}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      </group>
    </group>
  )
}