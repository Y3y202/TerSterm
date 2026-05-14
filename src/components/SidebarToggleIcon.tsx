import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

export function SidebarToggleIcon({ collapsed = false }: { collapsed?: boolean }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose

  return <Icon aria-hidden="true" className="h-4 w-4" />
}
