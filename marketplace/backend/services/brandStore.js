'use strict';

/**
 * DB-backed brand store for runtime-scaffolded storefronts.
 *
 * Built-in brands (true-earth, teneo, wealth-wise…) ship as files under
 * marketplace/frontend/brands/ and are read from disk. Brands scaffolded at
 * runtime via the Capability Restoration Catalog Claim Package path live in
 * Supabase, because @vercel/node serverless functions have a read-only
 * filesystem (everything outside /tmp) and direct Postgres connections to
 * Supabase free tier require the IPv4 add-on.
 *
 * This module uses the Supabase JS SDK over HTTPS (no Postgres pooler / IPv6
 * dependency). Schema for `teneo_marketplace_brands` must be applied to the
 * Supabase project via the SQL editor — see database/supabase-migration.sql.
 *
 * Required env vars (set on Vercel + locally):
 *   SUPABASE_URL              — e.g. https://ncddvxglmnnfagyyupeu.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (bypasses RLS, server-side only)
 *
 * Routes in `routes/storefront.js` serve config/catalog/theme.css from this
 * store, falling back to FS for built-in brands. The scaffolder writes here
 * as the authoritative source and best-effort to FS for local dev.
 */

const { createClient } = require('@supabase/supabase-js');

const TABLE = 'teneo_marketplace_brands';
let _client = null;
let _clientError = null;

function getClient() {
  if (_client) return _client;
  if (_clientError) throw _clientError;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_KEY
    || process.env.SUPABASE_ANON_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    _clientError = new Error(
      'brandStore: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required '
      + '(set on Vercel + .env). Service role recommended; anon will fail '
      + 'writes under RLS.'
    );
    _clientError.code = 'SUPABASE_NOT_CONFIGURED';
    throw _clientError;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'openbazaar-ai/brandStore' } },
  });
  return _client;
}

function deserialize(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    territoryId: row.territory_id,
    archetype: row.archetype,
    config: row.config_json || {},
    catalog: row.catalog_json || { books: [] },
    variables: row.variables_json || {},
    themeCss: row.theme_css || '',
    publishingCodeFlags: row.publishing_code_flags_json || [],
    publicUrl: row.public_url,
    catalogUrl: row.catalog_url,
    status: row.status,
    bookCount: Number(row.book_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getBySlug(slug) {
  const client = getClient();
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') {
    // PGRST116 = "Results contain 0 rows" — treat as null, not error.
    const err = new Error(`brandStore.getBySlug(${slug}): ${error.message}`);
    err.code = error.code;
    throw err;
  }
  return deserialize(data);
}

async function listByTerritory(territoryId) {
  const client = getClient();
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('territory_id', territoryId)
    .order('created_at', { ascending: false });
  if (error) {
    const err = new Error(`brandStore.listByTerritory(${territoryId}): ${error.message}`);
    err.code = error.code;
    throw err;
  }
  return (data || []).map(deserialize);
}

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

  const client = getClient();
  const now = new Date().toISOString();
  const row = {
    slug,
    territory_id: territoryId,
    archetype,
    config_json: config,
    catalog_json: catalog,
    variables_json: variables,
    theme_css: themeCss,
    publishing_code_flags_json: publishingCodeFlags,
    public_url: publicUrl,
    catalog_url: catalogUrl,
    status,
    book_count: bookCount,
    updated_at: now,
  };

  const { data, error } = await client
    .from(TABLE)
    .upsert(row, { onConflict: 'slug' })
    .select()
    .single();

  if (error) {
    const err = new Error(`brandStore.upsert(${slug}): ${error.message}`);
    err.code = error.code;
    throw err;
  }
  return deserialize(data);
}

async function setStatus(slug, status) {
  const client = getClient();
  const { data, error } = await client
    .from(TABLE)
    .update({ status, updated_at: new Date().toISOString() })
    .eq('slug', slug)
    .select()
    .single();
  if (error) {
    const err = new Error(`brandStore.setStatus(${slug}): ${error.message}`);
    err.code = error.code;
    throw err;
  }
  return deserialize(data);
}

module.exports = { upsert, getBySlug, listByTerritory, setStatus };
