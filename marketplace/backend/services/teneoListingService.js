'use strict';

const crypto = require('crypto');
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

function slugify(value) {
  const base = String(value || 'book')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'book';
}

function generateListingId() {
  return `lst_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeFormats(formats, priceUSD) {
  if (Array.isArray(formats) && formats.length > 0) {
    return formats.map((format) => ({
      type: format.type || format.format || 'pdf',
      priceUSD: Number(format.priceUSD ?? format.price_usd ?? priceUSD ?? 9.99),
      s3Source: format.s3Source || format.s3_source || null,
      url: format.url || format.downloadUrl || null,
      luluPodPackageId: format.luluPodPackageId || null,
    }));
  }
  return [{ type: 'pdf', priceUSD: Number(priceUSD || 9.99), s3Source: null, url: null }];
}

async function getListingById(listingId) {
  const row = await db.get(
    'SELECT * FROM teneo_marketplace_listings WHERE listing_id = ?',
    [listingId]
  );
  return row ? deserializeListing(row) : null;
}

async function getListingByBookId(bookId) {
  const row = await db.get(
    'SELECT * FROM teneo_marketplace_listings WHERE teneo_book_id = ? ORDER BY updated_at DESC LIMIT 1',
    [bookId]
  );
  return row ? deserializeListing(row) : null;
}

async function getStats(listingId = null) {
  if (listingId) {
    const listing = await getListingById(listingId);
    if (!listing) return null;
    return {
      listingId,
      views: Number(listing.stats.views || 0),
      addToCart: Number(listing.stats.addToCart || 0),
      purchases: Number(listing.stats.purchases || 0),
      revenueUSD: Number(listing.stats.revenueUSD || 0),
      refunds: Number(listing.stats.refunds || 0),
    };
  }

  const aggregate = await db.get(`
    SELECT
      COUNT(*) AS totalListings,
      COUNT(DISTINCT author_user_id) AS totalAuthors,
      COALESCE(SUM(purchases), 0) AS purchases,
      COALESCE(SUM(revenue_usd), 0) AS revenueUSD,
      COALESCE(SUM(refunds), 0) AS refunds
    FROM teneo_marketplace_listings
    WHERE status = 'live'
  `);

  return {
    totalListings: Number(aggregate?.totalListings || aggregate?.totallistings || 0),
    totalAuthors: Number(aggregate?.totalAuthors || aggregate?.totalauthors || 0),
    purchases: Number(aggregate?.purchases || 0),
    revenueUSD: Number(aggregate?.revenueUSD || aggregate?.revenueusd || 0),
    refunds: Number(aggregate?.refunds || 0),
  };
}

function deserializeListing(row) {
  const stats = {
    views: Number(row.views || 0),
    addToCart: Number(row.add_to_cart || 0),
    purchases: Number(row.purchases || 0),
    revenueUSD: Number(row.revenue_usd || 0),
    refunds: Number(row.refunds || 0),
  };

  return {
    listingId: row.listing_id,
    slug: row.slug,
    bookId: row.teneo_book_id,
    authorUserId: row.author_user_id,
    brandId: row.brand_id,
    niche: row.niche,
    title: row.title,
    subtitle: row.subtitle,
    author: row.author,
    descriptionMd: row.description_md,
    coverUrl: row.cover_url,
    formats: safeJson(row.formats_json, []),
    amazonAsin: row.amazon_asin,
    royaltySplit: safeJson(row.royalty_split_json, { author: 0.85, marketplace: 0.10, federation: 0.05 }),
    licenseTerms: row.license_terms,
    status: row.status,
    publicUrl: row.public_url,
    stats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

async function publishBook(payload) {
  const bookId = payload.bookId || payload.teneo_book_id;
  const title = payload.title;
  const authorUserId = payload.authorUserId || payload.author_user_id || payload.teneoUserId || payload.userId;

  if (!bookId || !title || !authorUserId) {
    const missing = [];
    if (!bookId) missing.push('bookId');
    if (!title) missing.push('title');
    if (!authorUserId) missing.push('authorUserId');
    const err = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const existing = await getListingByBookId(bookId);
  const listingId = existing?.listingId || payload.listingId || generateListingId();
  const slugBase = slugify(payload.slug || title);
  const slug = existing?.slug || `${slugBase}-${listingId.slice(-6)}`;
  const formats = normalizeFormats(payload.formats, payload.priceUSD || payload.price_usd);
  const priceUSD = Number(payload.priceUSD || payload.price_usd || formats[0]?.priceUSD || 9.99);
  const royaltySplit = payload.royaltySplit || payload.royalty_split || { author: 0.85, marketplace: 0.10, federation: 0.05 };
  const publicUrl = payload.publicUrl || `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/book-detail.html?id=${encodeURIComponent(listingId)}&source=teneo`;
  const status = payload.status || 'live';

  await db.run(`
    INSERT OR REPLACE INTO teneo_marketplace_listings (
      listing_id, slug, teneo_book_id, author_user_id, brand_id, niche, title, subtitle,
      author, description_md, cover_url, formats_json, amazon_asin, price_usd,
      royalty_split_json, license_terms, status, public_url, views, add_to_cart,
      purchases, revenue_usd, refunds, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM teneo_marketplace_listings WHERE listing_id = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, COALESCE((SELECT published_at FROM teneo_marketplace_listings WHERE listing_id = ?), CURRENT_TIMESTAMP))
  `, [
    listingId,
    slug,
    bookId,
    authorUserId,
    payload.brandId || payload.brand_id || null,
    payload.niche || null,
    title,
    payload.subtitle || null,
    payload.author || 'Teneo Author',
    payload.descriptionMd || payload.description || '',
    payload.coverUrl || payload.cover_url || null,
    JSON.stringify(formats),
    payload.amazonAsin || payload.amazon_asin || null,
    priceUSD,
    JSON.stringify(royaltySplit),
    payload.licenseTerms || payload.license_terms || 'personal-use',
    status,
    publicUrl,
    existing?.stats?.views || 0,
    existing?.stats?.addToCart || 0,
    existing?.stats?.purchases || 0,
    existing?.stats?.revenueUSD || 0,
    existing?.stats?.refunds || 0,
    listingId,
    listingId,
  ]);

  return getListingById(listingId);
}

async function updateListing(listingId, patch) {
  const existing = await getListingById(listingId);
  if (!existing) return null;
  return publishBook({
    ...existing,
    ...patch,
    bookId: existing.bookId,
    authorUserId: existing.authorUserId,
    listingId,
    status: patch.status || existing.status,
  });
}

async function unpublish(listingId, reason) {
  const existing = await getListingById(listingId);
  if (!existing) return null;
  await db.run(
    'UPDATE teneo_marketplace_listings SET status = ?, unpublish_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE listing_id = ?',
    ['unlisted', reason || null, listingId]
  );
  return getListingById(listingId);
}

async function recordPurchase(listingId, amountUSD) {
  await db.run(`
    UPDATE teneo_marketplace_listings
    SET purchases = COALESCE(purchases, 0) + 1,
        revenue_usd = COALESCE(revenue_usd, 0) + ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE listing_id = ?
  `, [Number(amountUSD || 0), listingId]);
}

async function recordRefund(listingId, amountUSD) {
  await db.run(`
    UPDATE teneo_marketplace_listings
    SET refunds = COALESCE(refunds, 0) + 1,
        revenue_usd = MAX(COALESCE(revenue_usd, 0) - ?, 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE listing_id = ?
  `, [Number(amountUSD || 0), listingId]);
}

module.exports = {
  publishBook,
  updateListing,
  unpublish,
  getListingById,
  getListingByBookId,
  getStats,
  recordPurchase,
  recordRefund,
};
