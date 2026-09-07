import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { SketchProvider } from './context/SketchContext'
import Breadboard from './pages/Breadboard'
import Parts from './pages/Parts'
import Sketches from './pages/Sketches'

export default function App() {
  return (
    <SketchProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Sketches />} />
            <Route path="parts" element={<Parts />} />
            <Route path="breadboard" element={<Breadboard />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SketchProvider>
  )
}
