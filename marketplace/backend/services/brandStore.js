'use strict';

/**
 * DB-backed brand store for runtime-scaffolded storefronts.
 *
 * Built-in brands (true-earth, teneo, wealth-wise…) ship as files under
 * marketplace/frontend/brands/ and are read from disk. Brands scaffolded at
 * runtime via the Capability Restoration Catalog Claim Package path live
 * here, because @vercel/node serverless functions have a read-only
 * filesystem (everything outside /tmp).
 *
 * Routes in `routes/storefront.js` serve config/catalog/theme.css from this
 * table, falling back to FS for built-in brands. The scaffolder writes here
 * as the authoritative source and best-effort to FS for local dev.
 */

const db = require('../database/database');

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function deserialize(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    territoryId: row.territory_id,
    archetype: row.archetype,
    config: safeJson(row.config_json, {}),
    catalog: safeJson(row.catalog_json, { books: [] }),
    variables: safeJson(row.variables_json, {}),
    themeCss: row.theme_css || '',
    publishingCodeFlags: safeJson(row.publishing_code_flags_json, []),
    publicUrl: row.public_url,
    catalogUrl: row.catalog_url,
    status: row.status,
    bookCount: Number(row.book_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getBySlug(slug) {
  const row = await db.get(
    'SELECT * FROM teneo_marketplace_brands WHERE slug = ?',
    [slug]
  );
  return deserialize(row);
}

async function listByTerritory(territoryId) {
  const rows = await db.all(
    'SELECT * FROM teneo_marketplace_brands WHERE territory_id = ? ORDER BY created_at DESC',
    [territoryId]
  );
  return (rows || []).map(deserialize);
}

/**
 * Upsert a brand record. Idempotent on slug.
 * `config`, `catalog`, `variables` are plain objects; `themeCss` is a string;
 * `publishingCodeFlags` is an array.
 */
async function upsert({
  slug,
  territoryId = null,
  archetype = null,
  config,
  catalog,
  variables = {},
  themeCss = '',
  publishingCodeFlags = [],
  publicUrl = null,
  catalogUrl = null,
  status = 'live',
  bookCount = 0,
}) {
  if (!slug) {
    const err = new Error('brand slug is required');
    err.statusCode = 400;
    throw err;
  }
  if (!config || typeof config !== 'object') {
    const err = new Error('brand config object is required');
    err.statusCode = 400;
    throw err;
  }
  if (!catalog || typeof catalog !== 'object') {
    const err = new Error('brand catalog object is required');
    err.statusCode = 400;
    throw err;
  }

  await db.run(
    `INSERT INTO teneo_marketplace_brands (
       slug, territory_id, archetype, config_json, catalog_json, variables_json,
       theme_css, publishing_code_flags_json, public_url, catalog_url, status,
       book_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(slug) DO UPDATE SET
       territory_id = excluded.territory_id,
       archetype = excluded.archetype,
       config_json = excluded.config_json,
       catalog_json = excluded.catalog_json,
       variables_json = excluded.variables_json,
       theme_css = excluded.theme_css,
       publishing_code_flags_json = excluded.publishing_code_flags_json,
       public_url = excluded.public_url,
       catalog_url = excluded.catalog_url,
       status = excluded.status,
       book_count = excluded.book_count,
       updated_at = CURRENT_TIMESTAMP`,
    [
      slug,
      territoryId,
      archetype,
      JSON.stringify(config),
      JSON.stringify(catalog),
      JSON.stringify(variables),
      themeCss,
      JSON.stringify(publishingCodeFlags),
      publicUrl,
      catalogUrl,
      status,
      bookCount,
    ]
  );

  return getBySlug(slug);
}

async function setStatus(slug, status) {
  await db.run(
    'UPDATE teneo_marketplace_brands SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?',
    [status, slug]
  );
  return getBySlug(slug);
}

module.exports = { upsert, getBySlug, listByTerritory, setStatus };
