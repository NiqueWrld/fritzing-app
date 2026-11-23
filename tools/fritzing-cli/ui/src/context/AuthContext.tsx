import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { auth } from '../lib/firebase'

type AuthContextValue = {
  /** False when Firebase env vars are missing. */
  enabled: boolean
  loading: boolean
  user: User | null
  /** Cloud storage is only available to signed-in users. */
  canUseStorage: boolean
  signInWithGoogle: () => Promise<void>
  signInWithEmail: (email: string, password: string) => Promise<void>
  signUpWithEmail: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  getIdToken: () => Promise<string | null>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function requireAuth() {
  if (!auth) throw new Error('Sign-in is not configured (missing VITE_FIREBASE_* env vars).')
  return auth
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(Boolean(auth))

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, (u) => {
      setUser(u)
      setLoading(false)
    })
  }, [])

  const value: AuthContextValue = {
    enabled: Boolean(auth),
    loading,
    user,
    canUseStorage: Boolean(user),
    signInWithGoogle: async () => {
      await signInWithPopup(requireAuth(), new GoogleAuthProvider())
    },
    signInWithEmail: async (email, password) => {
      await signInWithEmailAndPassword(requireAuth(), email, password)
    },
    signUpWithEmail: async (email, password) => {
      await createUserWithEmailAndPassword(requireAuth(), email, password)
    },
    signOut: async () => {
      if (auth) await fbSignOut(auth)
    },
    getIdToken: async () => (user ? user.getIdToken() : null),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
