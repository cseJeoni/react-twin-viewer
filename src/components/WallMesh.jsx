// src/components/WallMesh.jsx
import React, { useMemo } from 'react'
import * as THREE from 'three'

export default function WallMesh({ data, wallHeight = 20 }) {
  let outerSrc = Array.isArray(data?.outer) ? data.outer : null
  let innerSrc = Array.isArray(data?.inner) ? data.inner : null

  // 폴백: 생성 스크립트가 폴리곤 리스트를 줄 때(구형 포맷)
  if (!outerSrc || !innerSrc) {
    if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
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
      // 가장 큰 폴리곤을 inner로
      let maxA = -1, maxIdx = -1
      for (let i = 0; i < polys.length; i++) {
        const a = area(polys[i])
        if (a > maxA) { maxA = a; maxIdx = i }
      }
      if (maxIdx >= 0) {
        innerSrc = polys[maxIdx]
        // 바운딩 박스로 outer 생성(약간 margin)
        let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity
        for (const [x,y] of innerSrc) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
        const m = 2 // margin px
        outerSrc = [
          [minX - m, minY - m],
          [maxX + m, minY - m],
          [maxX + m, maxY + m],
          [minX - m, maxY + m],
        ]
      }
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
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh geometry={floorGeom} position={[0, 0, 0.1]} renderOrder={1}>
        <meshStandardMaterial
          color="#C5DCBF"
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
    </group>
  )
}
