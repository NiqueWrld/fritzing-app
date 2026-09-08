import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { SketchProvider } from './context/SketchContext'
import { ThemeProvider } from './context/ThemeContext'
import Breadboard from './pages/Breadboard'
import Connections from './pages/Connections'
import Parts from './pages/Parts'
import Schematic from './pages/Schematic'
import Settings from './pages/Settings'
import Sketches from './pages/Sketches'

export default function App() {
  return (
    <ThemeProvider>
      <SketchProvider>
        <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Sketches />} />
            <Route path="parts" element={<Parts />} />
            <Route path="breadboard" element={<Breadboard />} />
            <Route path="schematic" element={<Schematic />} />
            <Route path="connections" element={<Connections />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
        </BrowserRouter>
      </SketchProvider>
    </ThemeProvider>
  )
}
