import { createContext, useContext, useState, type ReactNode } from 'react'

type SketchContextValue = {
  currentSketch?: string
  setCurrentSketch: (path?: string) => void
}

const SketchContext = createContext<SketchContextValue | undefined>(undefined)

export function SketchProvider({ children }: { children: ReactNode }) {
  const [currentSketch, setCurrentSketch] = useState<string>()
  return <SketchContext.Provider value={{ currentSketch, setCurrentSketch }}>{children}</SketchContext.Provider>
}

export function useSketch(): SketchContextValue {
  const context = useContext(SketchContext)
  if (!context) throw new Error('useSketch must be used within a SketchProvider')
  return context
}
