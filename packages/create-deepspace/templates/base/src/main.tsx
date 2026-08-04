import { createRoot } from 'react-dom/client'
import { Routes, routes } from '@generouted/react-router/lazy'
import './styles.css'

function InitialRouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted-foreground">
      Loading…
    </div>
  )
}

const rootRoute = routes[0]
if (rootRoute) rootRoute.HydrateFallback = InitialRouteFallback

createRoot(document.getElementById('root')!).render(<Routes />)
