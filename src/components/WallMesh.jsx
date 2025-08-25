// src/components/WallMesh.jsx  (Reworked: uses outer/inner for uniform wall thickness)
import React, { useMemo } from 'react'
import * as THREE from 'three'

export default function WallMesh({ data, wallHeight = 20 }) {
  let outerSrc = Array.isArray(data?.outer) ? data.outer : null
  let innerSrc = Array.isArray(data?.inner) ? data.inner : null

  // 폴백: 구형 포맷(폴리곤 리스트)일 때
  if (!outerSrc || !innerSrc) {
    if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
      // 가장 큰 폴리곤을 inner 로 사용
      const polys = data
      const area = (pts) => {
        if (!pts || pts.length < 3) return 0
        let s = 0
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i]
          const [x2, y2] = pts[(i + 1) % pts.length]
          s += x1 * y2 - y1 * x2
        }
        return Math.abs(s) * 0.5
      }
      let maxIdx = 0, maxA = -1
      for (let i=0;i<polys.length;i++){
        const a = area(polys[i])
        if (a > maxA) { maxA = a; maxIdx = i }
      }
      innerSrc = polys[maxIdx]
      // 임시 outer: inner 의 bounding box + margin (구형 폴백 유지)
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity
      for (const [x,y] of innerSrc) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      const m = 10
      outerSrc = [
        [minX - m, minY - m],
        [maxX + m, minY - m],
        [maxX + m, maxY + m],
        [minX - m, maxY + m],
      ]
    }
  }

  if (!outerSrc || !innerSrc || outerSrc.length < 3 || innerSrc.length < 3) return null

  const toVec2 = pts => pts.map(([x, y]) => new THREE.Vector2(x, -y))
  const ensureCCW = v2 => (THREE.ShapeUtils.isClockWise(v2) ? v2.slice().reverse() : v2)
  const ensureCW  = v2 => (THREE.ShapeUtils.isClockWise(v2) ? v2 : v2.slice().reverse())

  const { wallGeom, floorGeom } = useMemo(() => {
    const outer = ensureCCW(toVec2(outerSrc))
    const innerCW = ensureCW(toVec2(innerSrc))

    const wallShape = new THREE.Shape(outer)
    wallShape.holes.push(new THREE.Path(innerCW))
    const wallGeom = new THREE.ExtrudeGeometry(wallShape, { depth: wallHeight, bevelEnabled: false })

    const innerCCW = ensureCCW(toVec2(innerSrc))
    const floorShape = new THREE.Shape(innerCCW)
    const floorGeom = new THREE.ShapeGeometry(floorShape)

    return { wallGeom, floorGeom }
  }, [outerSrc, innerSrc, wallHeight])

  return (
    <group>
      <mesh geometry={wallGeom} castShadow receiveShadow>
        <meshStandardMaterial color="#e8e8e8" metalness={0} roughness={0.8} />
      </mesh>
      <mesh geometry={floorGeom} position={[0, 0, 0.2]} renderOrder={1} receiveShadow>
        <meshStandardMaterial
          color="#CFE5D0"
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          metalness={0}
          roughness={1}
        />
      </mesh>
    </group>
  )
}