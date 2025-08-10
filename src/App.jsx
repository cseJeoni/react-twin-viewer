// src/App.jsx
import React from 'react'
import WallViewer from './components/WallViewer'
import SlamMap2D from './components/SlamMap2D' // ⬅️ 추가

function App() {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      backgroundColor: '#1a1a1a',
      // 큰 컨테이너에서 두 컴포넌트를 나란히 배치
      gap: 0
    }}>
      <div style={{ width: '50%', height: '100%' }}>
        <WallViewer />  {/* 기존 그대로 (내부에 2D 패널이 있어도 상관 없음) */}
      </div>
    </div>
  )
}

export default App
