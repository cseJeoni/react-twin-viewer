// src/components/SlamMap2D.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'

// WallViewer와 동일 WS (필요시 .env로 빼도 됨)
const WS_URL = `ws://192.168.75.186:8000/ws` // :contentReference[oaicite:2]{index=2}

// origin이 배열([x,y,theta])이든 객체({x0,y0})든 처리 (WallViewer와 동일 형태) :contentReference[oaicite:3]{index=3}
function getOrigin(metaOrigin){
  if (Array.isArray(metaOrigin)) return { x0: metaOrigin[0], y0: metaOrigin[1] }
  if (metaOrigin && typeof metaOrigin === 'object') return { x0: metaOrigin.x0, y0: metaOrigin.y0 }
  return { x0: 0, y0: 0 }
}

// meters -> pixels(이미지 좌표: x→오른쪽+, y→아래쪽+) :contentReference[oaicite:4]{index=4}
function metersToPixels({ x_m, y_m, origin, resolution }) {
  const { x0, y0 } = getOrigin(origin)
  const px = (x_m - x0) / resolution
  const py_img = (y_m - y0) / resolution
  return { px, py_img }
}

// 90° CCW 회전 (이미지 좌표계 기준, WallViewer와 동일) :contentReference[oaicite:5]{index=5}
function rotateCCW90({ px, py_img }, widthPx) {
  return { xPrime: py_img, yPrime_down: (widthPx - 1 - px) }
}

// 아핀 적용: (x,y,1)→(xi,yi)  (이미지 좌표계) :contentReference[oaicite:6]{index=6}
function applyAffine(T, x, y) {
  const xi = T[0][0]*x + T[0][1]*y + T[0][2]
  const yi = T[1][0]*x + T[1][1]*y + T[1][2]
  return { xi, yi }
}

export default function SlamMap2D() {
  const [meta, setMeta] = useState(null)
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)

  const imgRef = useRef(null)
  const wrapRef = useRef(null)
  const [imgInfo, setImgInfo] = useState({ naturalW: 0, naturalH: 0, dispW: 0, dispH: 0, offsetX: 0, offsetY: 0 })

  // meta.json 로드 (WallViewer도 meta.json을 사용) :contentReference[oaicite:7]{index=7}
  useEffect(() => {
    fetch('/meta.json')
      .then(r => { if (!r.ok) throw new Error('meta.json not found'); return r.json() })
      .then(setMeta)
      .catch(e => setErr(e.message))
  }, [])

  // WebSocket으로 pose 받기 (WallViewer와 동일 주소) :contentReference[oaicite:8]{index=8}
  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => console.log('[SlamMap2D WS] open', WS_URL)
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data)
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          setPose({ x: msg.x, y: msg.y })
        }
      } catch {}
    }
    ws.onerror = e => console.warn('[SlamMap2D WS] error', e)
    ws.onclose = e => console.log('[SlamMap2D WS] close', e.code)
    return () => { try { ws.close() } catch {} }
  }, [])

  // 이미지 로드 / 리사이즈 시 표시 크기와 위치 기록
  const updateImageMetrics = () => {
    const img = imgRef.current
    const wrap = wrapRef.current
    if (!img || !wrap) return
    const rect = img.getBoundingClientRect()
    setImgInfo({
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      dispW: rect.width,
      dispH: rect.height,
      offsetX: rect.left,
      offsetY: rect.top
    })
  }
  useEffect(() => {
    window.addEventListener('resize', updateImageMetrics)
    return () => window.removeEventListener('resize', updateImageMetrics)
  }, [])

  // SLAM 좌표 → 이미지 픽셀 좌표 (natural 기준)
  const robotPx = useMemo(() => {
    if (!pose || !meta) return null
    const { width, resolution, origin, rotateCCW90: rot, affine } = meta

    // ① 아핀 우선 (map 좌표→이미지 좌표 직행) :contentReference[oaicite:9]{index=9}
    if (Array.isArray(affine) && affine.length === 2 && affine[0].length === 3) {
      const { xi, yi } = applyAffine(affine, pose.x, pose.y)
      return { xImg: xi, yImg: yi }
    }

    // ② 폴백: origin/resolution (+필요시 90도 회전) :contentReference[oaicite:10]{index=10}
    const { px, py_img } = metersToPixels({ x_m: pose.x, y_m: pose.y, origin, resolution })
    if (rot) {
      const r = rotateCCW90({ px, py_img }, width)
      return { xImg: r.xPrime, yImg: r.yPrime_down }
    }
    return { xImg: px, yImg: py_img }
  }, [pose, meta])

  // natural → 현재 표시 크기 좌표로 스케일
  const robotDisp = useMemo(() => {
    if (!robotPx || !imgInfo.naturalW || !imgInfo.naturalH || !imgInfo.dispW || !imgInfo.dispH) return null
    const scaleX = imgInfo.dispW / imgInfo.naturalW
    const scaleY = imgInfo.dispH / imgInfo.naturalH
    return {
      left: robotPx.xImg * scaleX,
      top:  robotPx.yImg * scaleY
    }
  }, [robotPx, imgInfo])

  return (
    <div
      ref={wrapRef}
      style={{
        width: '50%',
        height: '100%',
        position: 'relative',
        backgroundColor: '#2a2a2a',
        border: '2px solid #444',
        borderRadius: 8,
        margin: 10,
        overflow: 'hidden'
      }}
    >
      <h3 style={{ color: 'white', textAlign: 'center', margin: '10px 0', fontSize: 16 }}>
        2D SLAM 맵 (별도 뷰어)
      </h3>

      <div style={{
        position: 'relative',
        width: '100%',
        height: 'calc(100% - 50px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <img
          ref={imgRef}
          src="/src/map_image/turtlebot3_burger_example_map.png" // 사용자 제공 이미지 이름
          alt="SLAM Map"
          style={{
            maxWidth: '95%',
            maxHeight: '95%',
            objectFit: 'contain',
            border: '1px solid #666'
          }}
          onLoad={updateImageMetrics}
        />

        {/* 빨간 점 오버레이 */}
        {robotDisp && (
          <div
            style={{
              position: 'absolute',
              // 이미지는 'contain'이므로 중앙 정렬된 여백을 고려해 보정 필요
              // 실제 표시된 이미지의 좌상단 위치를 구하기 위해 wrap과 img의 크기를 비교
              // 간단히 calc로 중앙여백 보정
              left: `calc(50% - ${imgInfo.dispW/2}px + ${robotDisp.left}px)`,
              top:  `calc(50% - ${imgInfo.dispH/2}px + ${robotDisp.top}px)`,
              width: 10,
              height: 10,
              backgroundColor: 'red',
              borderRadius: '50%',
              border: '2px solid white',
              boxShadow: '0 0 10px rgba(255,0,0,0.8)',
              transform: 'translate(-50%, -50%)',
              zIndex: 10
            }}
            title={pose ? `(${pose.x.toFixed(2)}, ${pose.y.toFixed(2)})` : ''}
          />
        )}
      </div>

      {pose && (
        <div style={{
          position: 'absolute',
          bottom: 10, left: 10,
          color: 'white', fontSize: 12,
          backgroundColor: 'rgba(0,0,0,0.7)',
          padding: '5px 10px', borderRadius: 4
        }}>
          위치: ({pose.x.toFixed(2)}, {pose.y.toFixed(2)})
        </div>
      )}

      {err && (
        <div style={{ position: 'absolute', top: 10, right: 10, color: 'crimson' }}>
          {err}
        </div>
      )}
    </div>
  )
}
