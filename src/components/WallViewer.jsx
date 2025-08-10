// src/components/WallViewer.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import WallMesh from './WallMesh'

const WS_URL = `ws://192.168.75.186:8000/ws`

// ---------- 기존 3D용 유틸 (그대로 둠) ----------
function getOrigin(metaOrigin){
  if (Array.isArray(metaOrigin)) return { x0: metaOrigin[0], y0: metaOrigin[1] }
  if (metaOrigin && typeof metaOrigin === 'object') return { x0: metaOrigin.x0, y0: metaOrigin.y0 }
  return { x0: 0, y0: 0 }
}
function metersToPixels({ x_m, y_m, origin, resolution }) {
  const { x0, y0 } = getOrigin(origin)
  const px = (x_m - x0) / resolution
  const py_img = (y_m - y0) / resolution
  return { px, py_img }
}
function rotateCCW90({ px, py_img }, widthPx) {
  return { xPrime: py_img, yPrime_down: (widthPx - 1 - px) }
}
function applyAffine(T, x, y) {
  const xi = T[0][0]*x + T[0][1]*y + T[0][2]
  const yi = T[1][0]*x + T[1][1]*y + T[1][2]
  return { xi, yi }
}

// ---------- 새로 추가: map.yaml 파싱 + PGM 디코더 ----------
function parseMapYaml(text) {
  const res = parseFloat((text.match(/resolution:\s*([0-9.\-eE]+)/) || [])[1])
  const originRaw = (text.match(/origin:\s*\[([^\]]+)\]/) || [])[1]
  const imageRaw = (text.match(/image:\s*["']?([^\n"']+)/) || [])[1]
  const origin = originRaw ? originRaw.split(',').map(s => parseFloat(s.trim())) : [0,0,0]
  return { resolution: res, origin, image: imageRaw ? imageRaw.trim() : null }
}

// 간단한 PGM(P5) 디코더 → PNG dataURL
async function pgmToDataURL(url) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`PGM fetch failed: ${resp.status}`)
  const buf = await resp.arrayBuffer()
  const bytes = new Uint8Array(buf)

  let i = 0
  const isSpace = (c) => c===9||c===10||c===13||c===32
  const readToken = () => {
    // skip spaces/comments
    while (i < bytes.length) {
      if (bytes[i] === 35) { // '#'
        while (i < bytes.length && bytes[i] !== 10) i++
      } else if (isSpace(bytes[i])) {
        i++
      } else break
    }
    let start = i
    while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== 35) i++
    return new TextDecoder().decode(bytes.slice(start, i))
  }

  const magic = readToken()
  if (magic !== 'P5') throw new Error(`Unsupported PGM magic: ${magic}`)

  const w = parseInt(readToken(), 10)
  const h = parseInt(readToken(), 10)
  const maxv = parseInt(readToken(), 10)

  // skip single whitespace after header
  if (isSpace(bytes[i])) i++; // at least one
  while (i < bytes.length && isSpace(bytes[i])) i++

  const expected = w * h
  const data = bytes.slice(i, i + expected)
  if (data.length !== expected) throw new Error('PGM size mismatch')

  // draw to canvas
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const imgData = ctx.createImageData(w, h)
  const scale = 255 / (maxv || 255)
  for (let p = 0, q = 0; p < expected; p++, q += 4) {
    const g = Math.max(0, Math.min(255, Math.round(data[p] * scale)))
    imgData.data[q] = g
    imgData.data[q+1] = g
    imgData.data[q+2] = g
    imgData.data[q+3] = 255
  }
  ctx.putImageData(imgData, 0, 0)
  return { dataURL: canvas.toDataURL('image/png'), width: w, height: h }
}

// 맵 좌표(x,y,m) → 이미지 픽셀(xImg,yImg, 위→아래 +)
function mapToImagePixel({ x, y }, meta) {
  const [x0, y0, theta = 0] = Array.isArray(meta.origin) ? meta.origin : [meta.origin?.x0||0, meta.origin?.y0||0, meta.origin?.theta||0]
  const dx = x - x0, dy = y - y0
  const c = Math.cos(theta), s = Math.sin(theta)
  const mx = ( c*dx + s*dy) / meta.resolution
  const my = (-s*dx + c*dy) / meta.resolution
  return { xImg: mx, yImg: (meta.height - 1) - my } // 이미지 Y 뒤집기
}

export default function WallViewer() {
  const [shapeData, setShapeData] = useState(null)
  const [meta, setMeta] = useState(null)     // {width,height,resolution,origin,imageSrc}
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)
  const controlsRef = useRef(null)
  const wsRef = useRef(null)

  // 2D 오버레이용 이미지 정보
  const imgRef = useRef(null)
  const [imgInfo, setImgInfo] = useState({ naturalW: 0, naturalH: 0, dispW: 0, dispH: 0 })
  const updateImageMetrics = () => {
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    setImgInfo({
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      dispW: rect.width,
      dispH: rect.height
    })
  }
  useEffect(() => {
    const handler = () => updateImageMetrics()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  // wall_shell.json + map.yaml 로드
  useEffect(() => {
    let imgObj
    Promise.all([
      fetch('/wall_shell.json').then(r => { if (!r.ok) throw new Error('wall_shell.json not found'); return r.json() }),
      fetch('/map.yaml').then(r => { if (!r.ok) throw new Error('map.yaml not found'); return r.text() })
    ])
    .then(async ([shape, yamlText]) => {
      setShapeData(shape)
      const y = parseMapYaml(yamlText) // {resolution, origin, image}
      // 이미지 소스 결정
      let imageSrc = y.image ? (y.image.startsWith('/') ? y.image : `/${y.image}`) : null
      let width = 0, height = 0

      if (imageSrc && imageSrc.toLowerCase().endsWith('.pgm')) {
        try {
          const { dataURL, width: w, height: h } = await pgmToDataURL(imageSrc)
          imageSrc = dataURL
          width = w; height = h
        } catch (e) {
          console.warn('[PGM] decode failed, trying PNG fallback:', e?.message)
          const pngAlt = imageSrc.replace(/\.pgm$/i, '.png')
          imageSrc = pngAlt
          // PNG 크기는 onLoad에서 naturalWidth/Height로 갱신
        }
      }

      // PNG이거나 dataURL이면 onLoad에서 naturalW/H로 확정되지만,
      // PGM→PNG dataURL일 경우 width/height를 이미 알고 있으므로 메타에 넣어둔다.
      setMeta({
        width, height,                // 0이면 onLoad에서 보완됨
        resolution: y.resolution,
        origin: y.origin,
        imageSrc
      })
    })
    .catch(e => setErr(e.message))
    return () => { imgObj = null }
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

  // 3D 카메라 로그(그대로)
  const handleControlsChange = (e) => {
    const c = e.target
    const az = THREE.MathUtils.radToDeg(c.getAzimuthalAngle()).toFixed(2)
    const po = THREE.MathUtils.radToDeg(c.getPolarAngle()).toFixed(2)
    console.log(`Azimuth: ${az}°, Polar: ${po}°`)
  }

  // ---- 3D 빨간 구: 2D와 동일 변환 사용 (mapToImagePixel) ----
  const redDotPos = useMemo(() => {
    if (!pose || !meta || !meta.resolution || !meta.origin) return null
    const H = meta.height || imgInfo.naturalH
    if (!H) return null
    const { xImg, yImg } = mapToImagePixel(pose, { resolution: meta.resolution, origin: meta.origin, height: H })
    return [xImg, -yImg, 0.6]  // Three.js에서는 Y 위로 + 이므로 부호 반전
  }, [pose, meta, imgInfo.naturalH])

  // ---- 2D: 맵 좌표 → 이미지 픽셀(자연 해상도) ----
  const robotPxOnImage = useMemo(() => {
    if (!pose || !meta || !meta.resolution || !meta.origin) return null
    return mapToImagePixel(pose, { resolution: meta.resolution, origin: meta.origin, height: meta.height || imgInfo.naturalH })
  }, [pose, meta, imgInfo.naturalH])

  // 자연 해상도 → 현재 표시 크기
  const dotDispPx = useMemo(() => {
    if (!robotPxOnImage || !imgInfo.dispW || !imgInfo.dispH || !(imgInfo.naturalW || meta?.width) || !(imgInfo.naturalH || meta?.height)) return null
    const naturalW = imgInfo.naturalW || meta.width
    const naturalH = imgInfo.naturalH || meta.height
    const scaleX = imgInfo.dispW / naturalW
    const scaleY = imgInfo.dispH / naturalH
    return {
      left: robotPxOnImage.xImg * scaleX,
      top:  robotPxOnImage.yImg * scaleY
    }
  }, [robotPxOnImage, imgInfo, meta])

  if (err) return <div style={{ padding: 16, color: 'crimson' }}>에러: {err}</div>
  if (!shapeData || !meta) return <div style={{ padding: 16 }}>Loading…</div>

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      {/* 왼쪽: 2D SLAM 맵 */}
      <div style={{ 
        width: '50%', height: '100%', position: 'relative',
        backgroundColor: '#2a2a2a', border: '2px solid #444',
        borderRadius: '8px', margin: '10px', overflow: 'hidden'
      }}>
        <h3 style={{ color: 'white', textAlign: 'center', margin: '10px 0', fontSize: '16px' }}>
          2D SLAM 맵
        </h3>
        
        <div style={{ 
          position: 'relative', width: '100%', height: 'calc(100% - 50px)',
          display: 'flex', justifyContent: 'center', alignItems: 'center'
        }}>
          <img 
            ref={imgRef}
            src={meta.imageSrc || '/src/map_image/turtlebot3_burger_example_map.png'}
            alt="SLAM Map" 
            style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', border: '1px solid #666' }}
            onLoad={(e) => {
              updateImageMetrics()
              const img = e.target
              // 이미지 로드 후 메타의 width/height가 0이면 보완
              if (meta && (!meta.width || !meta.height)) {
                setMeta(m => m ? { ...m, width: img.naturalWidth, height: img.naturalHeight } : m)
              }
            }}
          />
          
          {/* 2D 맵 위의 로봇 위치 표시 — 픽셀 기반 + 중앙 정렬 보정 */}
          {dotDispPx && (
            <div
              style={{
                position: 'absolute',
                left: `calc(50% - ${imgInfo.dispW / 2}px + ${dotDispPx.left}px)`,
                top:  `calc(50% - ${imgInfo.dispH / 2}px + ${dotDispPx.top}px)`,
                width: 10, height: 10, backgroundColor: 'red',
                borderRadius: '50%', border: '2px solid white',
                boxShadow: '0 0 10px rgba(255, 0, 0, 0.8)',
                transform: 'translate(-50%, -50%)', zIndex: 10
              }}
              title={pose ? `(${pose.x.toFixed(2)}, ${pose.y.toFixed(2)})` : ''}
            />
          )}
        </div>
        
        {/* 위치 정보 표시 */}
        {pose && (
          <div style={{ 
            position: 'absolute', bottom: '10px', left: '10px',
            color: 'white', fontSize: '12px',
            backgroundColor: 'rgba(0,0,0,0.7)', padding: '5px 10px', borderRadius: '4px'
          }}>
            위치: ({pose.x.toFixed(2)}, {pose.y.toFixed(2)})
          </div>
        )}
      </div>

      {/* 오른쪽: 3D 뷰어 */}
      <div style={{ width: '50%', height: '100%', margin: '10px' }}>
        <h3 style={{ color: 'white', textAlign: 'center', margin: '10px 0', fontSize: '16px' }}>
          3D 뷰어
        </h3>
        <div style={{ width: '100%', height: 'calc(100% - 50px)' }}>
          <Canvas camera={{ position: [350, -350, 320], fov: 40 }}>
            <ambientLight intensity={1.2} />
            <directionalLight position={[300, 400, 800]} intensity={1.4} />
            <directionalLight position={[-300, 200, 600]} intensity={1.0} />

            <OrbitControls
              ref={controlsRef}
              enableRotate
              enableZoom
              enablePan
              onChange={e => {
                const c = e.target
                const az = THREE.MathUtils.radToDeg(c.getAzimuthalAngle()).toFixed(2)
                const po = THREE.MathUtils.radToDeg(c.getPolarAngle()).toFixed(2)
                console.log(`Azimuth: ${az}°, Polar: ${po}°`)
              }}
            />

            <WallMesh data={shapeData} wallHeight={12} />

            {redDotPos && (
              <mesh position={redDotPos}>
                <sphereGeometry args={[3, 16, 16]} />
                <meshStandardMaterial color="red" emissive="red" emissiveIntensity={0.7} />
              </mesh>
            )}
          </Canvas>
        </div>
      </div>
    </div>
  )
}
