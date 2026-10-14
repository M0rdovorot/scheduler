import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { setupApi } from '@/api/setup'
import { App } from '@/app/App'
import { detectPlatform } from '@/platform'
import { PlatformContext } from '@/platform/context'
import { applyTheme } from '@/platform/theme'
import './index.css'

const platform = detectPlatform()
platform.init()
applyTheme(platform.getTheme())
platform.onThemeChange(applyTheme)

setupApi(platform)

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlatformContext.Provider value={platform}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </PlatformContext.Provider>
  </StrictMode>,
)
