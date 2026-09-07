import { createContext, useContext, useState, type ReactNode } from 'react'

type SketchContextValue = {
  currentSketch?: string
  setCurrentSketch: (path?: string) => void
}

const SketchContext = createContext<SketchContextValue | undefined>(undefined)

const storageKey = 'fritzing.currentSketch'

export function SketchProvider({ children }: { children: ReactNode }) {
  const [currentSketch, setCurrentSketchState] = useState<string | undefined>(
    () => localStorage.getItem(storageKey) ?? undefined
  )
  const setCurrentSketch = (path?: string) => {
    setCurrentSketchState(path)
    if (path) {
      localStorage.setItem(storageKey, path)
    } else {
      localStorage.removeItem(storageKey)
    }
  }
  return <SketchContext.Provider value={{ currentSketch, setCurrentSketch }}>{children}</SketchContext.Provider>
}

export function useSketch(): SketchContextValue {
  const context = useContext(SketchContext)
  if (!context) throw new Error('useSketch must be used within a SketchProvider')
  return context
}
