import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import WallMesh from './WallMesh'

// 서버 IP를 직접 쓰거나, 현재 호스트 자동 사용
const WS_URL = `ws://192.168.219.149:8000/ws`

// meters -> pixels (이미지 좌표: x 오른쪽+, y 아래쪽+)
function metersToPixels({ x_m, y_m, origin, resolution }) {
  const x0 = Array.isArray(origin) ? origin[0] : origin.x0
  const y0 = Array.isArray(origin) ? origin[1] : origin.y0
  const px = (x_m - x0) / resolution
  const py_img = (y_m - y0) / resolution
  return { px, py_img }
}

// 90° CCW 회전: (x,y_down) → (x',y'_down)
function rotateCCW90({ px, py_img }, widthPx) {
  const xPrime = py_img
  const yPrime_down = (widthPx - 1 - px)
  return { xPrime, yPrime_down }
}

export default function WallViewer() {
  const [shapeData, setShapeData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)
  const controlsRef = useRef(null)

  // JSON 로드
  useEffect(() => {
    Promise.all([
      fetch('/wall_shell.json').then(r => { if (!r.ok) throw new Error('wall_shell.json not found'); return r.json() }),
      fetch('/meta.json').then(r => { if (!r.ok) throw new Error('meta.json not found'); return r.json() })
    ])
      .then(([shape, metaJson]) => { setShapeData(shape); setMeta(metaJson) })
      .catch(e => setErr(e.message))
  }, [])

  // WebSocket
  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => console.log('[WS] open', WS_URL)
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data)
        // 서버는 {x,y}만 보내므로 그대로 사용
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          setPose({ x: msg.x, y: msg.y })
        }
      } catch {}
    }
    ws.onerror = e => console.warn('[WS] error', e)
    ws.onclose = e => console.log('[WS] close', e.code)
    return () => ws.close()
  }, [])

  // 카메라 각도 로그(조정 참고)
  const handleControlsChange = (e) => {
    const c = e.target
    const az = THREE.MathUtils.radToDeg(c.getAzimuthalAngle()).toFixed(2)
    const po = THREE.MathUtils.radToDeg(c.getPolarAngle()).toFixed(2)
    console.log(`Azimuth: ${az}°, Polar: ${po}°`)
  }

  // 포즈 → Three.js 좌표
  const redDotPos = useMemo(() => {
    if (!pose || !meta) return null
    const { resolution, origin, width, height, rotateCCW90: rot } = meta
    const { px, py_img } = metersToPixels({ x_m: pose.x, y_m: pose.y, origin, resolution })

    let xImg = px, yDown = py_img
    if (rot) {
      const r = rotateCCW90({ px, py_img }, width)
      xImg = r.xPrime
      yDown = r.yPrime_down
    }
    // 이미지 y(아래+) → Three y(위+): height로 반전
    const yUp = height - yDown
    return [xImg, yUp, 0.6]
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
