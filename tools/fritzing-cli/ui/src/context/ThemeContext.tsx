import { createContext, useContext, useState, type ReactNode } from 'react'

// Tokens are complete class strings so the Tailwind scanner picks them up.
export type Theme = {
  name: string
  primary: {
    icon: string
    button: string
    active: string
    hoverBorder: string
    focusBorder: string
    link: string
  }
  secondary: {
    appBg: string
    cardBg: string
    cardBorder: string
    surface: string
    surfaceHover: string
    border: string
    borderSoft: string
    input: string
    canvasBg: string
    gridColor: string
  }
  tint: {
    base: string
    text: string
    muted: string
    faint: string
    warning: string
  }
}

export const defaultTheme: Theme = {
  name: 'fritzing',
  primary: {
    icon: 'text-sky-600 dark:text-sky-400',
    button: 'bg-sky-600 hover:bg-sky-500 text-white',
    active: 'bg-sky-100 text-sky-700 dark:bg-slate-900 dark:text-sky-300',
    hoverBorder: 'hover:border-sky-500',
    focusBorder: 'focus:border-sky-500',
    link: 'text-sky-600 dark:text-sky-400 underline',
  },
  secondary: {
    appBg: 'bg-gray-100 dark:bg-gray-900',
    cardBg: 'bg-white dark:bg-gray-800',
    cardBorder: 'border-gray-200 dark:border-gray-700',
    surface: 'bg-gray-50 dark:bg-slate-900',
    surfaceHover: 'hover:bg-gray-100 dark:hover:bg-slate-900',
    border: 'border-gray-300 dark:border-slate-700',
    borderSoft: 'border-gray-200 dark:border-slate-800',
    input: 'border-gray-300 bg-white dark:border-slate-700 dark:bg-slate-900',
    canvasBg: 'bg-white',
    gridColor: 'rgba(0,50,100,0.08)',
  },
  tint: {
    base: 'text-gray-900 dark:text-slate-100',
    text: 'text-gray-700 dark:text-slate-300',
    muted: 'text-gray-600 dark:text-slate-400',
    faint: 'text-gray-500 dark:text-slate-500',
    warning: 'border-amber-600 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  },
}

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(defaultTheme)
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}
