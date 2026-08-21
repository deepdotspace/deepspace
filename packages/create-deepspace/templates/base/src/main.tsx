import { createRoot } from 'react-dom/client'
// Route-based code splitting keeps authenticated/collaborative pages out of
// the initial bundle for a public top-level route such as `/`.
import { routes } from '@generouted/react-router/lazy'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { installStaleChunkRecovery } from './stale-chunk-recovery'
import './styles.css'

const router = createBrowserRouter(routes)
installStaleChunkRecovery(router)

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
