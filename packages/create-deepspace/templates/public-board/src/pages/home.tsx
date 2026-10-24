import { Navigate } from 'react-router-dom'

/** Sign-in completion and the 404 page land on /home; this board lives at /. */
export default function Home() {
  return <Navigate to="/" replace />
}
