// src/components/WallViewer.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import WallMesh from './WallMesh'
import ObstacleMesh from './ObstacleMesh' // <--- [추가] ObstacleMesh 컴포넌트 임포트

const WS_URL = `ws://192.168.10.64:8000/ws`

// ===== util =====
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

// ===== 3D Pose Marker (inline; always inside <Canvas/>) =====
function useGlowTexture() {
  return React.useMemo(() => {
    const size = 256
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2)
    g.addColorStop(0.00, 'rgba(255,  0,  0, 0.95)') // 빨강 중심
    g.addColorStop(0.35, 'rgba(255,  0,  0, 0.35)')
    g.addColorStop(1.00, 'rgba(255,  0,  0, 0.00)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    tex.needsUpdate = true
    return tex
  }, [])
}
function useRingTexture() {
  return React.useMemo(() => {
    const size = 256
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, size, size)
    ctx.lineWidth = 16
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.beginPath()
    ctx.arc(size/2, size/2, size/2 - ctx.lineWidth, 0, Math.PI * 2)
    ctx.stroke()
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    tex.needsUpdate = true
    return tex
  }, [])
}
function PoseMarker3D({
  position = [0, 0, 0.6],
  coreRadius = 1.6,
  haloWorldSize = 28,
  pulseCount = 3,
  pulseFrom = 6,
  pulseTo = 18,
  pulseSpeed = 0.7,
  pulseColor = '#FF4D4D',
}) {
  const glowTex = useGlowTexture()
  const ringTex = useRingTexture()
  const ringsRef = useRef([])
  const phasesRef = useRef([])

  useEffect(() => {
    ringsRef.current = new Array(pulseCount)
    phasesRef.current = new Array(pulseCount).fill(0).map((_, i) => i / pulseCount)
  }, [pulseCount])

  useFrame((_, dt) => {
    const n = ringsRef.current.length
    for (let i = 0; i < n; i++) {
      const spr = ringsRef.current[i]
      if (!spr) continue
      phasesRef.current[i] += dt * pulseSpeed
      if (phasesRef.current[i] > 1) phasesRef.current[i] -= 1
      const t = phasesRef.current[i]
      const r = pulseFrom + (pulseTo - pulseFrom) * t
      const fade = 1 - t
      spr.material.opacity = 0.35 * fade
      const d = r * 2
      spr.scale.set(d, d, 1)
    }
  })

  return (
    <group position={position}>
      <mesh renderOrder={30}>
        <sphereGeometry args={[coreRadius, 24, 24]} />
        <meshStandardMaterial
color="#FF3B30"
emissive="#B00000"
emissiveIntensity={0.55}
          metalness={0}
          roughness={0.3}
        />
      </mesh>

      {haloWorldSize > 0 && (
        <sprite scale={[haloWorldSize, haloWorldSize, 1]} renderOrder={31}>
          <spriteMaterial
            map={glowTex}
            transparent
            depthTest={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            color="white"
          />
        </sprite>
      )}

      {new Array(pulseCount).fill(0).map((_, i) => (
        <sprite
          key={i}
          ref={el => (ringsRef.current[i] = el)}
          position={[0, 0, 0.21]}
          renderOrder={32}
        >
          <spriteMaterial
            map={ringTex}
            color={pulseColor}
            transparent
            opacity={0.3}
            depthTest={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      ))}
    </group>
  )
}

// ===== helpers: center camera & controls target =====
function SetControlsTarget({ controlsRef, target }) {
  const t = Array.isArray(target) ? target : [0, 0, 0]
  useEffect(() => {
    if (!controlsRef.current) return
    controlsRef.current.target.set(t[0], t[1], t[2] || 0)
    controlsRef.current.update()
  }, [controlsRef, t[0], t[1], t[2]])
  return null
}

/** 초기 각도를 yaw/pitch/distance로 지정(Z-up), 이후 카메라 유지 */
function SetCameraToCenter({ center, yawDeg = -35, pitchDeg = 62, distance = 520 }) {
  const { camera } = useThree()
  const c = Array.isArray(center) ? center : [0, 0, 0]
  useEffect(() => {
    camera.up.set(0, 0, 1)
    const yaw = THREE.MathUtils.degToRad(yawDeg)
    const pitch = THREE.MathUtils.degToRad(pitchDeg)
    const rXY = distance * Math.cos(pitch)
    const z   = distance * Math.sin(pitch)
    const x = c[0] + rXY * Math.cos(yaw)
    const y = c[1] + rXY * Math.sin(yaw)
    camera.position.set(x, y, z)
    camera.lookAt(c[0], c[1], c[2] || 0)
    camera.updateProjectionMatrix()
  }, [camera, c[0], c[1], c[2], yawDeg, pitchDeg, distance])
  return null
}

// ===== main component =====
export default function WallViewer() {
  const [shapeData, setShapeData] = useState(null)
  const [obstacleData, setObstacleData] = useState(null); // <--- [NEW] State for obstacle data
  const [meta, setMeta] = useState(null)
  const [pose, setPose] = useState(null)
  const [err, setErr] = useState(null)
  const [mode, setMode] = useState('3D')

  const controlsRef = useRef(null)
  const wsRef = useRef(null)
  const imgRef = useRef(null)
  const [imgInfo, setImgInfo] = useState({ naturalW: 0, naturalH: 0, dispW: 0, dispH: 0 })
  const updateImageMetrics = useCallback(() => {
    const img = imgRef.current; if (!img) return
    const rect = img.getBoundingClientRect()
    setImgInfo({ naturalW: img.naturalWidth, naturalH: img.naturalHeight, dispW: rect.width, dispH: rect.height })
  }, [])

  useEffect(() => {
    const handler = () => updateImageMetrics()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [updateImageMetrics])

  // meta/config/wall/obstacles load
  useEffect(() => {
    (async () => {
      try {
        // <--- [CHANGED] Fetch obstacles.json as well
        const [cfgR, metaR, wallR, obstacleR] = await Promise.all([
          fetch('/map-config.json'),
          fetch('/meta.json'),
          fetch('/wall_shell.json'),
          fetch('/obstacles.json'),
        ])
        if (!cfgR.ok) throw new Error('map-config.json not found')
        if (!metaR.ok) throw new Error('meta.json not found')
        if (!wallR.ok) throw new Error('wall_shell.json not found')
        if (!obstacleR.ok) throw new Error('obstacles.json not found') // <--- [NEW] Check for obstacles file

        const cfg = await cfgR.json()
        const metaJson = await metaR.json()
        const wall = await wallR.json()
        const obstacles = await obstacleR.json() // <--- [NEW] Parse obstacles
        setShapeData(wall)
        setObstacleData(obstacles) // <--- [NEW] Set obstacle data to state

        const qs = new URLSearchParams(window.location.search)
        const pick = qs.get('map') || cfg.active
        const profiles = cfg.profiles || cfg.maps || {}
        const prof = profiles[pick] || Object.values(profiles)[0]
        if (!prof) throw new Error('No profiles in map-config.json')

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
            } catch {
              imageSrc = imgPath.replace(/\.pgm$/i, '.png')
            }
          } else imageSrc = imgPath
        } else {
          const imgPath = toRoot(prof.pgm || prof.image || prof.png)
          if (!imgPath) throw new Error('No yaml/pgm/image in profile')
          if (imgPath.toLowerCase().endsWith('.pgm')) {
            const { dataURL, width: w0, height: h0 } = await pgmToDataURL(imgPath)
            imageSrc = dataURL; if (!w) w = w0; if (!h) h = h0
          } else imageSrc = imgPath
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

  // WebSocket
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

  // 3D pose position
  const redDotPos = useMemo(() => {
    if (!pose || !meta || !meta.resolution || !meta.origin) return null
    const H = meta.height || imgInfo.naturalH; if (!H) return null
    const { xImg, yImg } = mapToImagePixel(pose, { resolution: meta.resolution, origin: meta.origin, height: H })
    return [xImg, -yImg, 0.6]
  }, [pose, meta, imgInfo.naturalH])

  // Map center for camera targeting
  const mapCenter3D = useMemo(() => {
    if (!meta?.width || !meta?.height) return [0, 0, 0]
    return [meta.width / 2, -meta.height / 2, 0]
  }, [meta])

  // <--- [CHANGED] Loading condition now includes obstacleData
  if (err) return <div style={{ padding: 16, color: 'crimson' }}>에러: {err}</div>
  if (!shapeData || !meta || !obstacleData) return <div style={{ padding: 16 }}>Loading…</div>


  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#ffffff',
        overflow: 'hidden',
      }}
    >
      <Canvas
        camera={{ position: [0, 0, 320], fov: 40 }}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ gl }) => {
          gl.setClearColor('#ffffff', 1);
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <SetCameraToCenter
          center={mapCenter3D}
          yawDeg={-35}
          pitchDeg={62}
          distance={Math.max(meta.width, meta.height) * 0.9 + 250}
        />

        <ambientLight intensity={1.5} />
        <hemisphereLight  color="#ffffff" groundColor="#f4f4f4" intensity={0.9} />
        <directionalLight position={[300, 400, 800]} intensity={1.4} />
        <directionalLight position={[-300, 200, 600]} intensity={1.0} />

        <OrbitControls
          ref={controlsRef}
          enableRotate
          enableZoom
          enablePan
          enableDamping
          dampingFactor={0.08}
          minPolarAngle={THREE.MathUtils.degToRad(25)}
          maxPolarAngle={THREE.MathUtils.degToRad(80)}
          minDistance={Math.max(meta.width, meta.height) * 0.3}
          maxDistance={Math.max(meta.width, meta.height) * 2.0}
        />
        <SetControlsTarget controlsRef={controlsRef} target={mapCenter3D} />
        
        {/* Wall and Obstacle Meshes */}
        <WallMesh data={shapeData} wallHeight={35} />
        <ObstacleMesh data={obstacleData} obstacleHeight={25} /> {/* <--- [NEW] Render obstacles */}
        
        {redDotPos && (
          <PoseMarker3D
            position={redDotPos}
            coreRadius={1.6}
            haloWorldSize={10}
            pulseCount={3}
            pulseFrom={2}
            pulseTo={13}
            pulseSpeed={0.4}
          />
        )}
      </Canvas>
    </div>
  )
}