// src/components/WallViewer.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import WallMesh from './WallMesh'

const WS_URL = `ws://192.168.219.187:8000/ws`

// origin이 배열([x,y,theta])이든 객체({x0,y0})든 처리
function getOrigin(metaOrigin){
  if (Array.isArray(metaOrigin)) return { x0: metaOrigin[0], y0: metaOrigin[1] }
  if (metaOrigin && typeof metaOrigin === 'object') return { x0: metaOrigin.x0, y0: metaOrigin.y0 }
  return { x0: 0, y0: 0 }
}

// meters -> pixels (이미지 좌표: x 오른쪽+, y 아래쪽+)
function metersToPixels({ x_m, y_m, origin, resolution }) {
  const { x0, y0 } = getOrigin(origin)
  const px = (x_m - x0) / resolution
  const py_img = (y_m - y0) / resolution
  return { px, py_img }
}

// 90° CCW 회전 (이미지 좌표계 기준)
function rotateCCW90({ px, py_img }, widthPx) {
  return { xPrime: py_img, yPrime_down: (widthPx - 1 - px) }
}

// 아핀 적용: (x,y,1)→(xi,yi)  (이미지 좌표계)
function applyAffine(T, x, y) {
  const xi = T[0][0]*x + T[0][1]*y + T[0][2]
  const yi = T[1][0]*x + T[1][1]*y + T[1][2]
  return { xi, yi }
}

export default function WallViewer() {
  const [shapeData, setShapeData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)
  const controlsRef = useRef(null)
  const wsRef = useRef(null)

  // wall_shell.json + meta.json 로드
  useEffect(() => {
    Promise.all([
      fetch('/wall_shell.json').then(r => { if (!r.ok) throw new Error('wall_shell.json not found'); return r.json() }),
      fetch('/meta.json').then(r => { if (!r.ok) throw new Error('meta.json not found'); return r.json() })
    ])
    .then(([shape, metaJson]) => { setShapeData(shape); setMeta(metaJson) })
    .catch(e => setErr(e.message))
  }, [])

  // WebSocket (중복 연결 방지)
  useEffect(() => {
    if (wsRef.current) return
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.onopen = () => console.log('[WS] open', WS_URL)
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data)
        if (typeof msg.x === 'number' && typeof msg.y === 'number') setPose({ x: msg.x, y: msg.y })
      } catch {}
    }
    ws.onerror = e => console.warn('[WS] error', e)
    ws.onclose = e => console.log('[WS] close', e.code)
    return () => { try { wsRef.current?.close() } catch {} ; wsRef.current = null }
  }, [])

  // 컨트롤 각도 로그
  const handleControlsChange = (e) => {
    const c = e.target
    const az = THREE.MathUtils.radToDeg(c.getAzimuthalAngle()).toFixed(2)
    const po = THREE.MathUtils.radToDeg(c.getPolarAngle()).toFixed(2)
    console.log(`Azimuth: ${az}°, Polar: ${po}°`)
  }

  // 포즈 → Three.js 좌표 (벽 메쉬와 동일 규칙: y는 -이미지Y)
  const redDotPos = useMemo(() => {
    if (!pose || !meta) return null
    const { width, resolution, origin, rotateCCW90: rot, affine } = meta

    // ① affine 우선
    if (Array.isArray(affine) && affine.length === 2 && affine[0].length === 3) {
      const { xi, yi } = applyAffine(affine, pose.x, pose.y)
      return [xi, -yi, 0.6]                  // ★ 메쉬와 동일하게 y 부호 반전
    }

    // ② 폴백: origin/resolution (+필요시 90도)
    const { px, py_img } = metersToPixels({ x_m: pose.x, y_m: pose.y, origin, resolution })
    let xImg = px, yDown = py_img
    if (rot) {
      const r = rotateCCW90({ px, py_img }, width)
      xImg = r.xPrime
      yDown = r.yPrime_down
    }
    // 미세 조정: 방향 + 스케일링/오프셋 보정
    const scaleX = 1.0  // X축 스케일링 원래대로 (이동 범위 복원)
    const scaleY = 1.0  // Y축 스케일링 원래대로
    const offsetX = meta.width * 0.05    // X축 오프셋 줄임 (30% 위치)
    const offsetY = -meta.height * 0.7  // Y축 음수 오프셋으로 아래쪽 이동
    
    const correctedX = xImg * scaleX + offsetX
    const correctedY = yDown * scaleY + offsetY
    return [correctedX, correctedY, 0.6]
  }, [pose, meta])

  if (err) return <div style={{ padding: 16, color: 'crimson' }}>에러: {err}</div>
  if (!shapeData || !meta) return <div style={{ padding: 16 }}>Loading…</div>

  return (
    <Canvas camera={{ position: [350, -350, 320], fov: 40 }}>
      <ambientLight intensity={1.2} />
      <directionalLight position={[300, 400, 800]} intensity={1.4} />
      <directionalLight position={[-300, 200, 600]} intensity={1.0} />

      <OrbitControls
        ref={controlsRef}
        enableRotate
        enableZoom
        enablePan
        onChange={handleControlsChange}
      />

      <WallMesh data={shapeData} wallHeight={12} />

      {redDotPos && (
        <mesh position={redDotPos}>
          <sphereGeometry args={[3, 16, 16]} />
          <meshStandardMaterial color="red" emissive="red" emissiveIntensity={0.7} />
        </mesh>
      )}
    </Canvas>
  )
}
