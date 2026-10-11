import type { SharedProject } from '../../src/project-directory.js'
import type { LogoImage } from '../../src/logo-image.js'

/** A room override wins. Without it, use the deliberately selected joined
 * project, or the sole joined project. Several projects have no implicit
 * owner: names/initials remain visible until a context is selected. */
export function inheritedRoomLogo(room: string, override: LogoImage | null | undefined, projects: readonly SharedProject[], selected?: string): LogoImage | undefined {
  if (override) return override
  const eligible = projects.filter(p => p.joined && !p.withdrawn && !p.conflicted && p.definition && !p.definition.archived && p.definition.rooms.some(r => r.room === room))
  const project = eligible.find(p => `shared:${p.key}` === selected) ?? (eligible.length === 1 ? eligible[0] : undefined)
  return project && !project.logoConflicted ? project.logo ?? undefined : undefined
}
