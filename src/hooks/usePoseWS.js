// usePoseWS.js
import { useEffect, useState } from 'react'
export default function usePoseWS(url) {
  const [pose, setPose] = useState(null)
  useEffect(() => {
    const ws = new WebSocket(url)
    ws.onmessage = (ev) => { try { setPose(JSON.parse(ev.data)) } catch {} }
    return () => ws.close()           // 🔴 언마운트/리로드 시 닫기
  }, [url])
  return pose
}
