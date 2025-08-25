// src/components/WallViewer.jsx  (Reworked: orthographic/isometric camera + cleaner materials/lighting)
import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera } from '@react-three/drei'
import WallMesh from './WallMesh'

const WS_URL = `ws://192.168.219.146:8000/ws`

// --- Helpers (unchanged) ---
function parseMapYaml(text) {
  const res = parseFloat((text.match(/resolution:\s*([0-9.\-eE]+)/) || [])[1])
  const originRaw = (text.match(/origin:\s*\[([^\]]+)\]/) || [])[1]
  const imageRaw = (text.match(/image:\s*["']?([^\n"']+)/) || [])[1]
  const origin = originRaw ? originRaw.split(',').map(s => parseFloat(s.trim())) : [0,0,0]
  return { resolution: res, origin, image: imageRaw ? imageRaw.trim() : null }
}
async function pgmToDataURL(url) {
  const resp = await fetch(url); if (!resp.ok) throw new Error(`PGM fetch failed: ${resp.status}`)
  const buf = await resp.arrayBuffer(); const bytes = new Uint8Array(buf)
  let i = 0; const isSpace = c => c===9||c===10||c===13||c===32
  const readToken = () => { while (i<bytes.length){ if (bytes[i]===35){ while(i<bytes.length&&bytes[i]!==10)i++ } else if (isSpace(bytes[i])){ i++ } else break }
    const s=i; while(i<bytes.length && !isSpace(bytes[i]) && bytes[i]!==35)i++; return new TextDecoder().decode(bytes.slice(s,i)) }
  const magic=readToken(); if(magic!=='P5') throw new Error(`Unsupported PGM magic: ${magic}`)
  const w=parseInt(readToken(),10), h=parseInt(readToken(),10), maxv=parseInt(readToken(),10)
  if (isSpace(bytes[i])) i++; while (i<bytes.length && isSpace(bytes[i])) i++
  const expected=w*h; const data=bytes.slice(i,i+expected); if(data.length!==expected) throw new Error('PGM size mismatch')
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h
  const ctx=canvas.getContext('2d',{willReadFrequently:true}); const imgData=ctx.createImageData(w,h)
  const scale=255/(maxv||255); for(let p=0,q=0;p<expected;p++,q+=4){ const g=Math.max(0,Math.min(255,Math.round(data[p]*scale)))
    imgData.data[q]=g; imgData.data[q+1]=g; imgData.data[q+2]=g; imgData.data[q+3]=255 }
  ctx.putImageData(imgData,0,0); return { dataURL: canvas.toDataURL('image/png'), width:w, height:h }
}
function mapToImagePixel({ x, y }, meta) {
  const [x0, y0, theta = 0] = Array.isArray(meta.origin) ? meta.origin : [meta.origin?.x0||0, meta.origin?.y0||0, meta.origin?.theta||0]
  const dx = x - x0, dy = y - y0
  const c = Math.cos(theta), s = Math.sin(theta)
  const mx = ( c*dx + s*dy) / meta.resolution
  const my = (-s*dx + c*dy) / meta.resolution
  return { xImg: mx, yImg: (meta.height - 1) - my }
}
const toRoot = (p) => (p?.startsWith('/') ? p : `/${p}`)
const resolvePath = (baseUrl, rel) => {
  if (!rel) return null
  if (/^https?:\/\//i.test(rel) || rel.startsWith('/')) return rel
  const baseDir = baseUrl.replace(/[^/]*$/, '')
  return baseDir + rel
}

export default function WallViewer() {
  const [shapeData, setShapeData] = useState(null)
  const [meta, setMeta] = useState(null)     // {width,height,resolution,origin,imageSrc}
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)
  const wsRef = useRef(null)

  const imgRef = useRef(null)
  const [imgInfo, setImgInfo] = useState({ naturalW: 0, naturalH: 0, dispW: 0, dispH: 0 })
  const updateImageMetrics = () => {
    const img = imgRef.current; if (!img) return
    const rect = img.getBoundingClientRect()
    setImgInfo({ naturalW: img.naturalWidth, naturalH: img.naturalHeight, dispW: rect.width, dispH: rect.height })
  }
  useEffect(() => {
    const handler = () => updateImageMetrics()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  // ✅ map-config.json + meta.json + wall_shell.json 로드
  useEffect(() => {
    (async () => {
      try {
        const [cfgR, metaR, wallR] = await Promise.all([
          fetch('/map-config.json'),
          fetch('/meta.json'),
          fetch('/wall_shell.json'),
        ])
        if (!cfgR.ok) throw new Error('map-config.json not found')
        if (!metaR.ok) throw new Error('meta.json not found')
        if (!wallR.ok) throw new Error('wall_shell.json not found')

        const cfg = await cfgR.json()
        const metaJson = await metaR.json()
        const wall = await wallR.json()
        setShapeData(wall)

        const qs = new URLSearchParams(window.location.search)
        const pick = qs.get('map') || cfg.active
        const profiles = cfg.profiles || cfg.maps || {}
        const prof = profiles[pick] || Object.values(profiles)[0]
        if (!prof) throw new Error('No profiles in map-config.json')

        // 이미지 소스 선택
        let imageSrc = null, w = metaJson.width || 0, h = metaJson.height || 0
        if (prof.yaml) {
          const yamlUrl = toRoot(prof.yaml)
          const yText = await (await fetch(yamlUrl)).text()
          const y = parseMapYaml(yText)
          const imgPath = resolvePath(yamlUrl, y.image)
          if (!imgPath) throw new Error('image path missing in YAML')
          if (imgPath.toLowerCase().endsWith('.pgm')) {
            try {
              const { dataURL, width: w0, height: h0 } = await pgmToDataURL(imgPath)
              imageSrc = dataURL; if (!w) w = w0; if (!h) h = h0
            } catch (e) {
              imageSrc = imgPath.replace(/\.pgm$/i, '.png')
            }
          } else {
            imageSrc = imgPath
          }
        } else {
          const imgPath = toRoot(prof.pgm || prof.image || prof.png)
          if (!imgPath) throw new Error('No yaml/pgm/image in profile')
          if (imgPath.toLowerCase().endsWith('.pgm')) {
            const { dataURL, width: w0, height: h0 } = await pgmToDataURL(imgPath)
            imageSrc = dataURL; if (!w) w = w0; if (!h) h = h0
          } else {
            imageSrc = imgPath
          }
        }

        setMeta({
          width: w, height: h,
          resolution: metaJson.resolution,
          origin: metaJson.origin,
          imageSrc
        })
      } catch (e) {
        setErr(e.message)
      }
    })()
  }, [])

  // WebSocket (pose 수신)
  useEffect(() => {
    if (wsRef.current) return
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.onopen = () => console.log('[WS] open', WS_URL)
    ws.onmessage = ev => { try {
      const msg = JSON.parse(ev.data)
      if (typeof msg.x === 'number' && typeof msg.y === 'number') setPose({ x: msg.x, y: msg.y })
    } catch {} }
    ws.onerror = e => console.warn('[WS] error', e)
    ws.onclose = e => console.log('[WS] close', e.code)
    return () => { try { wsRef.current?.close() } catch {} ; wsRef.current = null }
  }, [])

  // 3D 빨간 점 위치
  const redDotPos = useMemo(() => {
    if (!pose || !meta || !meta.resolution || !meta.origin) return null
    const H = meta.height || imgInfo.naturalH; if (!H) return null
    const { xImg, yImg } = mapToImagePixel(pose, { resolution: meta.resolution, origin: meta.origin, height: H })
    return [xImg, -yImg, 8] // 위로 살짝 띄움
  }, [pose, meta, imgInfo.naturalH])

  // 2D 오버레이 좌표
  const robotPxOnImage = useMemo(() => {
    if (!pose || !meta || !meta.resolution || !meta.origin) return null
    return mapToImagePixel(pose, { resolution: meta.resolution, origin: meta.origin, height: meta.height || imgInfo.naturalH })
  }, [pose, meta, imgInfo.naturalH])

  const dotDispPx = useMemo(() => {
    if (!robotPxOnImage || !imgInfo.dispW || !imgInfo.dispH || !(imgInfo.naturalW || meta?.width) || !(imgInfo.naturalH || meta?.height)) return null
    const naturalW = imgInfo.naturalW || meta.width
    const naturalH = imgInfo.naturalH || meta.height
    const scaleX = imgInfo.dispW / naturalW
    const scaleY = imgInfo.dispH / naturalH
    return { left: robotPxOnImage.xImg * scaleX, top: robotPxOnImage.yImg * scaleY }
  }, [robotPxOnImage, imgInfo, meta])

  if (err) return <div style={{ padding: 16, color: 'crimson' }}>에러: {err}</div>
  if (!shapeData || !meta) return <div style={{ padding: 16 }}>Loading…</div>

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      {/* 2D SLAM */}
      <div style={{ width: '50%', height: '100%', position: 'relative', backgroundColor: '#2a2a2a', border: '2px solid #444', borderRadius: '8px', margin: '10px', overflow: 'hidden' }}>
        <h3 style={{ color: 'white', textAlign: 'center', margin: '10px 0', fontSize: '16px' }}>2D SLAM 맵</h3>
        <div style={{ position: 'relative', width: '100%', height: 'calc(100% - 50px)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <img
            ref={imgRef}
            src={meta.imageSrc}
            alt="SLAM Map"
            style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', border: '1px solid #666' }}
            onLoad={(e) => {
              updateImageMetrics()
              const img = e.target
              if (meta && (!meta.width || !meta.height)) {
                // eslint-disable-next-line
                setMeta(m => m ? { ...m, width: img.naturalWidth, height: img.naturalHeight } : m)
              }
            }}
          />
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
        {pose && (
          <div style={{ position: 'absolute', bottom: '10px', left: '10px', color: 'white', fontSize: '12px', backgroundColor: 'rgba(0,0,0,0.7)', padding: '5px 10px', borderRadius: '4px' }}>
            위치: ({pose.x.toFixed(2)}, {pose.y.toFixed(2)})
          </div>
        )}
      </div>

      {/* 3D */}
      <div style={{ width: '50%', height: '100%', margin: '10px' }}>
        <h3 style={{ color: 'white', textAlign: 'center', margin: '10px 0', fontSize: '16px' }}>3D 뷰어</h3>
        <div style={{ width: '100%', height: 'calc(100% - 50px)' }}>
          <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }}>
            {/* 정갈한 2.5D 느낌의 직교 카메라 */}
            <OrthographicCamera
              makeDefault
              position={[600, -600, 500]}
              zoom={2.0}
              near={-10000}
              far={10000}
            />
            <ambientLight intensity={0.9} />
            <directionalLight
              castShadow
              position={[600, 800, 1200]}
              intensity={1.1}
              shadow-mapSize-width={2048}
              shadow-mapSize-height={2048}
            />
            <OrbitControls
              enablePan={false}
              minPolarAngle={Math.PI/4}
              maxPolarAngle={Math.PI/3}
              minZoom={0.8}
              maxZoom={6}
            />
            <WallMesh data={shapeData} wallHeight={24} />
            {redDotPos && (
              <mesh position={redDotPos} castShadow>
                <sphereGeometry args={[6, 24, 24]} />
                <meshStandardMaterial color="red" emissive="red" emissiveIntensity={0.6} />
              </mesh>
            )}
          </Canvas>
        </div>
      </div>
    </div>
  )
}