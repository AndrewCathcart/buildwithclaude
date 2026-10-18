/**
 * Persist marketplace-declared skills.
 *
 * File-backed skills are upserted into `plugins` (type = skill) so /skills can
 * list them. Every declared skill, including bare names, is replaced in the
 * `skills` table for the marketplaces just indexed. That table has no unique
 * key, so insert-ignore would keep the old path slugs forever.
 */

import { db } from '@/lib/db/client'
import { plugins, skills } from '@/lib/db/schema'
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'

export interface DeclaredSkillPluginInsert {
  name: string
  namespace: string
  slug: string
  marketplaceId: string
  marketplaceName: string
  repository: string
  description: string
  version?: string
  author: string
  categories: string[]
  keywords: string[]
  installCommand: string
  stars: number
  content?: string
  sourcePath?: string
  lastIndexedAt: Date
}

export interface DeclaredSkillRowInsert {
  name: string
  slug: string
  marketplaceId: string
  marketplaceName: string
  repository: string
  description: string
  category?: string | null
  allowedTools?: string[]
  model?: string
  lastIndexedAt: Date
}

const PLUGIN_CHUNK = 20
const SKILL_CHUNK = 100

/**
 * Upsert SKILL.md-backed skills and deactivate file-backed skill rows for these
 * marketplaces that are no longer declared.
 */
export async function syncDeclaredSkillPlugins(
  marketplaceIds: string[],
  records: DeclaredSkillPluginInsert[],
): Promise<number> {
  let upserted = 0
  for (let i = 0; i < records.length; i += PLUGIN_CHUNK) {
    const batch = records.slice(i, i + PLUGIN_CHUNK)
    try {
      await db
        .insert(plugins)
        .values(batch.map(record => ({
          name: record.name,
          namespace: record.namespace,
          slug: record.slug,
          marketplaceId: record.marketplaceId,
          marketplaceName: record.marketplaceName,
          repository: record.repository,
          description: record.description,
          version: record.version,
          author: record.author,
          type: 'skill' as const,
          categories: record.categories,
          keywords: record.keywords,
          installCommand: record.installCommand,
          stars: record.stars,
          content: record.content,
          sourcePath: record.sourcePath,
          active: true,
          lastIndexedAt: record.lastIndexedAt,
        })))
        .onConflictDoUpdate({
          target: plugins.namespace,
          set: {
            name: sql`EXCLUDED.name`,
            slug: sql`EXCLUDED.slug`,
            description: sql`EXCLUDED.description`,
            version: sql`EXCLUDED.version`,
            author: sql`EXCLUDED.author`,
            type: sql`EXCLUDED.type`,
            categories: sql`EXCLUDED.categories`,
            keywords: sql`EXCLUDED.keywords`,
            marketplaceId: sql`EXCLUDED.marketplace_id`,
            marketplaceName: sql`EXCLUDED.marketplace_name`,
            repository: sql`EXCLUDED.repository`,
            installCommand: sql`EXCLUDED.install_command`,
            content: sql`COALESCE(EXCLUDED.content, ${plugins.content})`,
            sourcePath: sql`COALESCE(EXCLUDED.source_path, ${plugins.sourcePath})`,
            stars: sql`GREATEST(${plugins.stars}, EXCLUDED.stars)`,
            active: true,
            lastIndexedAt: sql`EXCLUDED.last_indexed_at`,
            updatedAt: sql`NOW()`,
          },
        })
      upserted += batch.length
    } catch (error) {
      console.error(`Declared skill plugin upsert failed for ${batch.length} rows:`, error)
    }
  }

  for (const marketplaceId of marketplaceIds) {
    const keep = records
      .filter(record => record.marketplaceId === marketplaceId)
      .map(record => record.namespace)
    try {
      const stale = and(
        eq(plugins.marketplaceId, marketplaceId),
        eq(plugins.type, 'skill'),
        isNotNull(plugins.sourcePath),
        keep.length > 0 ? notInArray(plugins.namespace, keep) : undefined,
      )
      await db
        .update(plugins)
        .set({ active: false, updatedAt: new Date() })
        .where(stale)
    } catch (error) {
      console.error(`Failed to deactivate removed skills for marketplace ${marketplaceId}:`, error)
    }
  }

  return upserted
}

/**
 * Replace skill-table rows for the indexed marketplaces.
 * Deletes first so path-slug rows from older runs do not linger beside the corrected names.
 */
export async function replaceMarketplaceSkillRows(
  marketplaceIds: string[],
  records: DeclaredSkillRowInsert[],
): Promise<number> {
  for (let i = 0; i < marketplaceIds.length; i += SKILL_CHUNK) {
    const chunk = marketplaceIds.slice(i, i + SKILL_CHUNK)
    try {
      await db.delete(skills).where(inArray(skills.marketplaceId, chunk))
    } catch (error) {
      console.error(`Failed to clear skills for ${chunk.length} marketplaces:`, error)
    }
  }

  let inserted = 0
  for (let i = 0; i < records.length; i += SKILL_CHUNK) {
    const batch = records.slice(i, i + SKILL_CHUNK)
    try {
      await db.insert(skills).values(batch)
      inserted += batch.length
    } catch (error) {
      console.error('Declared skill insert failed:', error)
    }
  }
  return inserted
}
