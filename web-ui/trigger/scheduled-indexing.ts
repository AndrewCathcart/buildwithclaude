import { schedules } from '@trigger.dev/sdk/v3'
import { indexMCPServers, syncMCPServerStats } from '@/lib/indexer/mcp-server-indexer'
import { indexMarketplaces } from '@/lib/indexer/marketplace-indexer'
import { indexPlugins } from '@/lib/indexer/plugin-indexer'
import { indexSkillsFromSkillsSh } from '@/lib/indexer/skills-sh-indexer'

/**
 * Scheduled indexing tasks
 *
 * Schedule:
 * - Sunday & Thursday: MCP stats sync
 * - Monday: MCP servers indexing
 * - Tuesday & Friday: Marketplaces indexing
 * - Wednesday & Saturday: Plugins indexing
 * - Daily: skills.sh
 * - Daily: deploy-static content reindex (agents/commands/hooks/plugins/skills)
 *
 * Each task refreshes the Meilisearch index for the type it just synced (see
 * reindexSearch) so search stays in step with the DB.
 */

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://buildwithclaude.com'

/**
 * Ask the web app to refresh the Meilisearch index for the given content types.
 * We delegate to the web admin endpoint rather than reindexing inside the
 * Trigger.dev task: the web service has the local markdown files (so a
 * 'skill'/'plugin' reindex won't drop locally-sourced docs) and the Meilisearch
 * connection. Requires ADMIN_API_TOKEN in this task's env; logs and skips
 * otherwise. Never throws — a search hiccup must not fail the DB sync.
 */
async function reindexSearch(types: string[]): Promise<void> {
  const adminToken = process.env.ADMIN_API_TOKEN
  if (!adminToken) {
    console.warn('[search] ADMIN_API_TOKEN not set; skipping reindex')
    return
  }
  for (const type of types) {
    try {
      const res = await fetch(`${APP_BASE_URL}/api/admin/reindex-search?mode=type&type=${type}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      console.log(`[search] reindex ${type} -> HTTP ${res.status}`)
    } catch (error) {
      console.error(`[search] reindex ${type} failed:`, error)
    }
  }
}

// MCP Servers - Monday at 5 AM UTC
export const scheduledMcpServersIndex = schedules.task({
  id: 'scheduled-mcp-servers-index',
  cron: '0 5 * * 1',
  run: async (payload) => {
    console.log(`MCP servers indexing started at ${payload.timestamp}`)
    const result = await indexMCPServers()
    await reindexSearch(['mcp-server'])
    return { ...result, scheduledAt: payload.timestamp }
  },
})

// Marketplaces - Tuesday & Friday at 5 AM UTC
export const scheduledMarketplacesIndex = schedules.task({
  id: 'scheduled-marketplaces-index',
  cron: '0 5 * * 2,5',
  run: async (payload) => {
    console.log(`Marketplaces indexing started at ${payload.timestamp}`)
    const result = await indexMarketplaces()
    await reindexSearch(['marketplace'])
    return { ...result, scheduledAt: payload.timestamp }
  },
})

// Plugins - Wednesday & Saturday at 5 AM UTC
export const scheduledPluginsIndex = schedules.task({
  id: 'scheduled-plugins-index',
  cron: '0 5 * * 3,6',
  run: async (payload) => {
    console.log(`Plugins indexing started at ${payload.timestamp}`)
    const result = await indexPlugins()
    await reindexSearch(['plugin', 'skill'])
    return { ...result, scheduledAt: payload.timestamp }
  },
})

// skills.sh - daily at 5 AM UTC (key-less web crawl: discovery + incremental
// content sync; bounded per run by the staleness slice + windowed flush)
export const scheduledSkillsShIndex = schedules.task({
  id: 'scheduled-skills-sh-index',
  cron: '0 5 * * *',
  run: async (payload) => {
    console.log(`skills.sh indexing started at ${payload.timestamp}`)
    const result = await indexSkillsFromSkillsSh()
    await reindexSearch(['skill'])
    return { ...result, scheduledAt: payload.timestamp }
  },
})

// MCP Stats - Sunday & Thursday at 5 AM UTC
export const scheduledMcpStatsSync = schedules.task({
  id: 'scheduled-mcp-stats-sync',
  cron: '0 5 * * 0,4',
  run: async (payload) => {
    console.log(`MCP stats sync started at ${payload.timestamp}`)
    const result = await syncMCPServerStats()
    await reindexSearch(['mcp-server'])
    return { ...result, scheduledAt: payload.timestamp }
  },
})

// Deploy-static content (agents/commands/hooks/plugins/skills) - daily at 5:30 AM UTC.
// These sources are read from the deployed repo at index time and change only on
// deploy. Without this, a category rename or new local plugin/skill may never
// reach search until a manual full reindex. Offset from the 5:00 batch to avoid
// piling onto the same admin-endpoint window.
export const scheduledMarkdownContentIndex = schedules.task({
  id: 'scheduled-markdown-content-index',
  cron: '30 5 * * *',
  run: async (payload) => {
    console.log(`Deploy-static content reindex started at ${payload.timestamp}`)
    const reindexed = ['subagent', 'command', 'hook', 'plugin', 'skill']
    await reindexSearch(reindexed)
    return { reindexed, scheduledAt: payload.timestamp }
  },
})
