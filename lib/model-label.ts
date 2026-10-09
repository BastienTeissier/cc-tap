// Model ids carry their version in the id itself, so labels are parsed rather
// than listed: a new release (claude-opus-5-5, claude-sonnet-6) gets the right
// label without touching this file.

const FAMILIES = 'opus|sonnet|haiku|fable|mythos'

// claude-opus-5-5, claude-opus-4-20250514, claude-opus-4-5@20251101,
// anthropic.claude-opus-4-8-v1:0, claude-opus-5[1m]. The minor is one or two
// digits followed by a boundary, so a date suffix is never read as one.
const CURRENT_ID = new RegExp(`claude-(${FAMILIES})-(\\d+)(?:-(\\d{1,2}))?(?=$|[-@:\\[.])`)
// Pre-4 ids put the version first: claude-3-5-sonnet-20241022
const LEGACY_ID = new RegExp(`claude-(\\d+)(?:-(\\d))?-(${FAMILIES})(?=$|[-@:\\[.])`)

export interface ParsedModel {
  family: string
  /** "5.5", "4", ... */
  version: string
}

export function parseModel(id: string): ParsedModel | null {
  const current = CURRENT_ID.exec(id)
  if (current) {
    const [, family, major, minor] = current
    return { family, version: minor ? `${major}.${minor}` : major }
  }
  const legacy = LEGACY_ID.exec(id)
  if (legacy) {
    const [, major, minor, family] = legacy
    return { family, version: minor ? `${major}.${minor}` : major }
  }
  return null
}

/** "claude-opus-5-5" -> "Opus 5.5"; any other id (gpt-5.5, <synthetic>) as is */
export function modelLabel(id: string): string {
  const m = parseModel(id)
  if (!m) return id
  return `${m.family[0].toUpperCase()}${m.family.slice(1)} ${m.version}`
}

/** "claude-opus-5-5-20260901" -> "claude-opus-5.5"; any other id as is */
export function modelShortId(id: string): string {
  const m = parseModel(id)
  return m ? `claude-${m.family}-${m.version}` : id
}
