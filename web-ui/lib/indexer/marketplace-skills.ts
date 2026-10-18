import matter from 'gray-matter'

export interface MarketplaceSkillPlugin {
  name: string
  skills?: string[] | null
  source?: unknown
  category?: string | null
}

export interface ResolvedMarketplaceSkill {
  name: string
  slug: string
  description: string
  category: string | null | undefined
  /** True when the name or description came from SKILL.md frontmatter. */
  resolved: boolean
  content?: string
  sourcePath?: string
}

/**
 * Namespace for a skill published from a marketplace plugin.
 * Avoids colliding with the parent plugin row (`@owner/plugin-name`).
 */
export function skillPluginNamespace(owner: string, pluginName: string, skillSlug: string): string {
  const ownerName = owner.trim().replace(/^@/, '')
  const base = `@${ownerName}/${skillSlug}`
  if (base === `@${ownerName}/${pluginName}`) return `@${ownerName}/${pluginName}/${skillSlug}`
  return base
}

// Only resolve paths inside a local plugin. Remote/pinned sources need their
// own repository/ref resolution; never fetch them from the marketplace repo.
function localPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.startsWith('/') || /[:\\?#]/.test(value)) return null
  const parts = value.split('/')
  if (parts.includes('..')) return null
  return parts.filter(part => part && part !== '.').join('/')
}

/** Resolve locally declared skill paths, retaining legacy metadata on failure. */
export async function resolveMarketplaceSkills(
  plugin: MarketplaceSkillPlugin,
  repoFullName: string,
  fetchFileContent: (repo: string, path: string) => Promise<string>,
): Promise<ResolvedMarketplaceSkill[]> {
  const source = localPath(plugin.source === undefined ? '.' : plugin.source)
  const skills: ResolvedMarketplaceSkill[] = []

  for (const entry of plugin.skills || []) {
    if (!entry) continue
    let name = entry
    let description = `Skill from ${plugin.name}`
    let resolved = false
    let content: string | undefined
    let sourcePath: string | undefined
    const skillPath = localPath(entry)

    // Plain names belong to legacy registries, not filesystem declarations.
    if (source !== null && skillPath && (entry.includes('/') || entry === 'SKILL.md')) {
      const filePath = [source, skillPath, skillPath.endsWith('.md') ? '' : 'SKILL.md']
        .filter(Boolean).join('/')
      try {
        const file = await fetchFileContent(repoFullName, filePath)
        // gray-matter also supports executable JavaScript frontmatter. Only
        // allow YAML before invoking it on untrusted repository content.
        if (!/^\uFEFF?---[ \t]*(?:yaml|yml)?[ \t]*\r?\n/.test(file)) {
          throw new Error('Only YAML frontmatter is supported')
        }
        const parsed = matter(file)
        if (typeof parsed.data.name === 'string' && parsed.data.name.trim()) {
          name = parsed.data.name.trim().slice(0, 255)
          resolved = true
        }
        if (typeof parsed.data.description === 'string' && parsed.data.description.trim()) {
          description = parsed.data.description.trim()
          resolved = true
        }
        if (resolved) {
          content = parsed.content
          sourcePath = filePath
        }
      } catch {
        // A missing file or malformed frontmatter must not discard the plugin
        // or prevent the remaining declared skills from being indexed.
      }
    }

    skills.push({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      description,
      category: plugin.category,
      resolved,
      ...(resolved ? { content, sourcePath } : {}),
    })
  }

  return skills
}
