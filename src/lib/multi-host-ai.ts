import type { AiAssistantPermission } from '../types'

export interface MultiHostTargetDescriptor {
  pane_id: string
  title: string
  host?: string
  username?: string
  host_platform?: string
  linux_distro?: string
  role?: string
}

export interface MultiHostPlanCapture {
  name: string
  pattern: string
}

export interface MultiHostPlanStep {
  id: string
  title: string
  targets: string[]
  command: string
  execute: boolean
  parallel: boolean
  capture?: MultiHostPlanCapture
}

export interface MultiHostPlan {
  summary?: string
  steps: MultiHostPlanStep[]
}

export interface ParsedMultiHostPlanReply {
  content: string
  plan?: MultiHostPlan
}

const MULTI_HOST_PLAN_TAG_PATTERN = /<tersterm-batch-plan>([\s\S]*?)<\/tersterm-batch-plan>/i

const stripJsonCodeFence = (value: string) =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

const normalizeTargets = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean)
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }

  return []
}

const normalizeCapture = (value: unknown): MultiHostPlanCapture | undefined => {
  if (!value || typeof value !== 'object') return undefined

  const capture = value as Record<string, unknown>
  const name = String(capture.name || '').trim()
  const pattern = String(capture.pattern || '').trim()

  if (!name || !pattern) return undefined
  return { name, pattern }
}

const normalizeSteps = (value: unknown): MultiHostPlanStep[] => {
  if (!Array.isArray(value)) return []

  const steps: MultiHostPlanStep[] = []

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return

    const raw = entry as Record<string, unknown>
    const command = String(raw.command || '').trim()
    if (!command) return

    const id = String(raw.id || '').trim() || `step-${index + 1}`
    const title = String(raw.title || '').trim() || `Step ${index + 1}`
    const targets = normalizeTargets(raw.targets)

    if (targets.length === 0) return

    steps.push({
      id,
      title,
      targets,
      command,
      execute: raw.execute !== false,
      parallel: raw.parallel === true,
      capture: normalizeCapture(raw.capture),
    })
  })

  return steps
}

export const parseMultiHostPlanReply = (reply: string): ParsedMultiHostPlanReply => {
  const source = String(reply || '')
  const match = MULTI_HOST_PLAN_TAG_PATTERN.exec(source)
  const content = source.replace(MULTI_HOST_PLAN_TAG_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim()

  if (!match?.[1]) {
    return { content }
  }

  try {
    const parsed = JSON.parse(stripJsonCodeFence(match[1])) as Record<string, unknown>
    const steps = normalizeSteps(parsed.steps)

    if (steps.length === 0) {
      return { content }
    }

    return {
      content: content || String(parsed.summary || '').trim(),
      plan: {
        summary: String(parsed.summary || '').trim() || undefined,
        steps,
      },
    }
  } catch {
    return { content }
  }
}

const describeTarget = (target: MultiHostTargetDescriptor) => {
  const endpoint = target.username && target.host ? `${target.username}@${target.host}` : target.host || target.title
  const role = target.role?.trim() ? ` role=${target.role.trim()}` : ''
  const platform = target.host_platform?.trim() ? ` platform=${target.host_platform.trim()}` : ''
  const distro = target.linux_distro?.trim() ? ` distro=${target.linux_distro.trim()}` : ''
  return `- ${target.pane_id}: ${target.title} | ${endpoint}${role}${platform}${distro}`
}

export const buildMultiHostSystemPrompt = (
  basePrompt: string,
  targets: MultiHostTargetDescriptor[],
  permission: AiAssistantPermission,
) => {
  const normalizedBasePrompt = basePrompt.trim()
  const permissionSummary =
    permission === 'execute'
      ? 'The user can review a plan and then run commands.'
      : permission === 'type-only'
        ? 'The user can review a plan and TerSterm can type commands without pressing Enter.'
        : 'The user can review a plan, but TerSterm must not type or execute commands automatically.'

  return [
    normalizedBasePrompt,
    '',
    'You are helping with multi-host SSH orchestration inside TerSterm.',
    permissionSummary,
    'When the user asks for a multi-host install, deployment, bootstrap, or cluster change, return concise guidance followed by exactly one <tersterm-batch-plan>...</tersterm-batch-plan> block.',
    'The block content must be raw JSON only. Do not wrap it in markdown fences.',
    'JSON schema:',
    '{',
    '  "summary": "short summary",',
    '  "steps": [',
    '    {',
    '      "id": "unique-step-id",',
    '      "title": "short step title",',
    '      "targets": ["pane-id-1"] or ["all"],',
    '      "command": "single shell command string",',
    '      "execute": true,',
    '      "parallel": false,',
    '      "capture": { "name": "variable_name", "pattern": "(regex capture or full match)" }',
    '    }',
    '  ]',
    '}',
    'Rules:',
    '- Use only pane ids from the available target list below.',
    '- Use ["all"] only when the exact same command should run on every selected host.',
    '- Keep one command string per step, ready to send to a shell. Do not include prompts, comments, or markdown in commands.',
    '- Later steps may reference captured values using {{variable_name}}.',
    '- Prefer explicit ordered steps for cluster workflows such as kubeadm init, extracting the join command, and joining workers.',
    '- Use "parallel": true only when the step is safe to launch on multiple hosts at the same time.',
    '- If the user is only asking for advice and not asking to type or run anything, omit the batch plan entirely.',
    '',
    'Example capture for kubeadm join:',
    '{ "name": "kubeadm_join_command", "pattern": "(kubeadm join[\\\\s\\\\S]*?--discovery-token-ca-cert-hash\\\\s+sha256:[a-f0-9]+)" }',
    '',
    'Available targets:',
    ...targets.map(describeTarget),
  ].join('\n')
}

export const substituteMultiHostPlanVariables = (
  command: string,
  variables: Record<string, string>,
) =>
  command.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, rawName: string) => {
    const name = rawName.trim()
    if (!(name in variables)) {
      throw new Error(`Missing captured variable: ${name}`)
    }

    return variables[name]
  })
