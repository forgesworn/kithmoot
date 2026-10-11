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

/** Before admission, a link proves no room membership. Only an already
 * verified, deliberately joined directory can supply preview artwork. Match
 * its exact invitation fragment until admission proves the room ID. A
 * refreshed invitation may then use the same authorised project context. */
export function projectAdmissionBrand(link: string, projects: readonly SharedProject[], resolvedRoom?: string, selected?: string): {
  room: string; name: string; projectName: string; image?: LogoImage
} | undefined {
  let fragment: string
  try { fragment = new URL(link).hash } catch { return }
  if (!fragment || fragment === '#') return
  const rooms = projects.filter(p => p.joined && !p.withdrawn && !p.conflicted && p.definition && !p.definition.archived).flatMap(project =>
    project.definition!.rooms.flatMap(room => {
      try { return [{ project, room, fragment: new URL(room.link).hash }] } catch { return [] }
    }))
  const matchingLink = rooms.filter(c => c.fragment === fragment)
  if (resolvedRoom && matchingLink.some(c => c.room.room !== resolvedRoom)) return
  const candidates = resolvedRoom ? rooms.filter(c => c.room.room === resolvedRoom) : matchingLink
  if (new Set(candidates.map(c => c.room.room)).size !== 1) return
  const chosen = candidates.find(c => `shared:${c.project.key}` === selected) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!chosen) return
  return { room: chosen.room.room, name: chosen.room.name, projectName: chosen.project.definition!.name,
    ...(chosen.project.logo && !chosen.project.logoConflicted ? { image: chosen.project.logo } : {}) }
}
