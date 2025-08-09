import React, { useMemo } from 'react'
import * as THREE from 'three'

/**
 * props:
 *  - data: { outer: number[][], inner: number[][] }
 *  - wallHeight: number (기본 20)
 * 결과:
 *  - 벽: outer + hole(inner) Extrude → 흰색
 *  - 바닥: inner Shape → #C5DCBF
 */
export default function WallMesh({ data, wallHeight = 20 }) {
  const outerSrc = Array.isArray(data?.outer) ? data.outer : []
  const innerSrc = Array.isArray(data?.inner) ? data.inner : []
  if (outerSrc.length < 3 || innerSrc.length < 3) return null

  const toVec2 = pts => pts.map(([x, y]) => new THREE.Vector2(x, -y))
  const ensureCCW = v2 => (THREE.ShapeUtils.isClockWise(v2) ? v2.slice().reverse() : v2)
  const ensureCW  = v2 => (THREE.ShapeUtils.isClockWise(v2) ? v2 : v2.slice().reverse())

  const { wallGeom, floorGeom } = useMemo(() => {
    // 외곽 CCW, 구멍 CW
    const outer = ensureCCW(toVec2(outerSrc))
    const innerCW = ensureCW(toVec2(innerSrc))

    const wallShape = new THREE.Shape(outer)
    wallShape.holes.push(new THREE.Path(innerCW))
    const wallGeom = new THREE.ExtrudeGeometry(wallShape, {
      depth: wallHeight,
      bevelEnabled: false
    })

    const innerCCW = ensureCCW(toVec2(innerSrc))
    const floorShape = new THREE.Shape(innerCCW)
    const floorGeom = new THREE.ShapeGeometry(floorShape)

    return { wallGeom, floorGeom }
  }, [outerSrc, innerSrc, wallHeight])

  return (
    <group>
      {/* 벽 = 흰색 */}
      <mesh geometry={wallGeom} castShadow receiveShadow>
        <meshStandardMaterial color="#ffffff" />
      </mesh>

      {/* 바닥 = #C5DCBF (z-fighting 방지 약간 띄움) */}
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
