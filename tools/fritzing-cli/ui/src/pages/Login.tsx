import { GoogleLogoIcon } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'

export default function Login() {
  const { enabled, user, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut } = useAuth()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    run(() => (mode === 'signin' ? signInWithEmail(email, password) : signUpWithEmail(email, password)))
  }

  const card = `mx-auto mt-12 max-w-sm rounded-xl border p-6 ${theme.secondary.cardBg} ${theme.secondary.cardBorder}`

  if (!enabled) {
    return (
      <div className={card}>
        <h1 className="mb-2 text-lg font-semibold">Sign-in unavailable</h1>
        <p className={`text-sm ${theme.tint.muted}`}>
          Firebase isn't configured. You can keep using the app without an account; cloud storage is off.
        </p>
      </div>
    )
  }

  if (user) {
    return (
      <div className={card}>
        <h1 className="mb-2 text-lg font-semibold">Signed in</h1>
        <p className={`mb-4 text-sm ${theme.tint.muted}`}>{user.email ?? user.displayName}</p>
        <button className={`w-full rounded-lg px-3 py-2 text-sm ${theme.primary.button}`} onClick={() => signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div className={card}>
      <h1 className="mb-1 text-lg font-semibold">{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
      <p className={`mb-4 text-xs ${theme.tint.faint}`}>
        Optional. Sign in to save sketches to the cloud. <Link to="/" className={theme.primary.link}>Continue without an account</Link>
      </p>
      <button
        disabled={busy}
        onClick={() => run(signInWithGoogle)}
        className={`mb-4 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.secondary.border} ${theme.secondary.surfaceHover}`}
      >
        <GoogleLogoIcon size={18} /> Continue with Google
      </button>
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
          className={`rounded-lg border px-3 py-2 text-sm outline-none ${theme.secondary.input} ${theme.primary.focusBorder}`} />
        <input type="password" required minLength={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          className={`rounded-lg border px-3 py-2 text-sm outline-none ${theme.secondary.input} ${theme.primary.focusBorder}`} />
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        <button disabled={busy} type="submit" className={`rounded-lg px-3 py-2 text-sm ${theme.primary.button}`}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button className={`mt-3 text-xs ${theme.primary.link}`} onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
        {mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}
      </button>
    </div>
  )
}
