import { Monitor, Server } from 'lucide-react'
import { cn } from '../lib/utils'
import type { ConnectionProfile } from '../types'

type LinuxBadgeSpec = {
  background: string
  foreground: string
  label: string
  name: string
}

const normalizeLinuxDistro = (value?: string) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return ''

  if (normalized === 'opensuse-leap' || normalized === 'opensuse-tumbleweed') return 'opensuse'
  if (normalized === 'amzn' || normalized === 'amazonlinux' || normalized === 'amazon-linux') return 'amazon'
  if (normalized === 'redhat' || normalized === 'red-hat' || normalized === 'red_hat') return 'rhel'
  return normalized
}

const linuxBadgeByDistro: Record<string, LinuxBadgeSpec> = {
  ubuntu: { background: '#E95420', foreground: '#fff7ed', label: 'U', name: 'Ubuntu' },
  debian: { background: '#A81D33', foreground: '#fff1f2', label: 'D', name: 'Debian' },
  centos: { background: '#7C3AED', foreground: '#f5f3ff', label: 'C', name: 'CentOS' },
  rhel: { background: '#EE0000', foreground: '#fff1f2', label: 'R', name: 'Red Hat' },
  rocky: { background: '#15803D', foreground: '#f0fdf4', label: 'R', name: 'Rocky Linux' },
  almalinux: { background: '#2563EB', foreground: '#eff6ff', label: 'A', name: 'AlmaLinux' },
  fedora: { background: '#294172', foreground: '#eff6ff', label: 'F', name: 'Fedora' },
  arch: { background: '#1793D1', foreground: '#eff6ff', label: 'A', name: 'Arch Linux' },
  manjaro: { background: '#35BF5C', foreground: '#f0fdf4', label: 'M', name: 'Manjaro' },
  alpine: { background: '#0F5B8D', foreground: '#eff6ff', label: 'A', name: 'Alpine' },
  opensuse: { background: '#73BA25', foreground: '#f7fee7', label: 'S', name: 'openSUSE' },
  amazon: { background: '#FF9900', foreground: '#fff7ed', label: 'A', name: 'Amazon Linux' },
  oracle: { background: '#C74634', foreground: '#fff1f2', label: 'O', name: 'Oracle Linux' },
  nixos: { background: '#5277C3', foreground: '#eff6ff', label: 'N', name: 'NixOS' },
  gentoo: { background: '#54487A', foreground: '#f5f3ff', label: 'G', name: 'Gentoo' },
  linux: { background: '#4B5563', foreground: '#f8fafc', label: 'L', name: 'Linux' },
}

const linuxBadgeForConnection = (connection?: Pick<ConnectionProfile, 'host_platform' | 'linux_distro'>) => {
  if (!connection) return undefined
  if (connection.host_platform !== 'linux' && !connection.linux_distro) return undefined

  const distro = normalizeLinuxDistro(connection.linux_distro)
  return linuxBadgeByDistro[distro] ?? linuxBadgeByDistro.linux
}

interface HostSystemIconProps {
  className?: string
  connection?: Pick<ConnectionProfile, 'host_platform' | 'linux_distro'>
}

export function HostSystemIcon({ className, connection }: HostSystemIconProps) {
  const linuxBadge = linuxBadgeForConnection(connection)
  if (linuxBadge) {
    return (
      <span
        title={linuxBadge.name}
        aria-label={linuxBadge.name}
        className={cn(
          'grid h-4 w-4 place-items-center rounded-[4px] text-[8px] font-black leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]',
          className,
        )}
        style={{ backgroundColor: linuxBadge.background, color: linuxBadge.foreground }}
      >
        {linuxBadge.label}
      </span>
    )
  }

  if (connection?.host_platform === 'windows') {
    return <Monitor className={cn('h-3.5 w-3.5', className)} />
  }

  return <Server className={cn('h-3.5 w-3.5', className)} />
}

export default HostSystemIcon
