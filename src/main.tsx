import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'
import './i18n'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={120}>
      <App />
      <Toaster richColors position="top-right" />
    </TooltipProvider>
  </QueryClientProvider>,
)
