/**
 * Storefront API — Standardized catalog and fulfillment endpoints.
 *
 * This is the API that external consumers (like ArxMint's /bazaar page) use
 * to fetch product catalogs and trigger order fulfillment.
 *
 * Endpoints:
 *   GET  /api/storefront/catalog           - Full product catalog (standardized schema)
 *   GET  /api/storefront/catalog/:category  - Products filtered by category
 *   GET  /api/storefront/product/:id        - Single product detail
 *   POST /api/storefront/checkout           - Create checkout session (routes to payment provider)
 *   POST /api/storefront/fulfill            - Webhook: payment confirmed → fulfill order
 *
 * Schema matches BAZAAR_STRATEGY.md Product interface.
 */

'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const arxmintProvider = require('../services/arxmintProvider');
const OrderService = require('../services/orderService');
const emailService = require('../services/emailService');
const fulfillmentService = require('../services/fulfillmentService');
const zapService = require('../services/zapService');
const brandStore = require('../services/brandStore');

// Brand-folder paths for built-in brands (true-earth, teneo, wealth-wise, etc.)
// Built-in brands ship as files; runtime-scaffolded brands live in DynamoDB
// (read-only filesystem on @vercel/node). Lookup tries DB first, falls back
// to FS.
const BUILTIN_BRANDS_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'brands');

function isValidSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

async function readBuiltinFile(slug, ...segments) {
  if (!isValidSlug(slug)) return null;
  const target = path.resolve(BUILTIN_BRANDS_DIR, slug, ...segments);
  if (!target.startsWith(BUILTIN_BRANDS_DIR + path.sep)) return null;
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

const orderService = new OrderService();

// ---------------------------------------------------------------------------
// BTC/USD rate cache — used to add sat pricing to catalog products
// ---------------------------------------------------------------------------

let _btcRateCache = { rate: null, fetchedAt: 0 };
const BTC_RATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getBtcUsdRate() {
  if (_btcRateCache.rate && Date.now() - _btcRateCache.fetchedAt < BTC_RATE_TTL_MS) {
    return _btcRateCache.rate;
  }
  try {
    const resp = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { timeout: 5000 }
    );
    const rate = resp.data && resp.data.bitcoin && resp.data.bitcoin.usd;
    if (rate) {
      _btcRateCache = { rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch {
    // CoinGecko unavailable — return cached value if we have one
    if (_btcRateCache.rate) return _btcRateCache.rate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert internal book catalog format to standardized Product schema.
 * Maps the existing brand/catalog.json format to the schema ArxMint expects.
 */
function bookToProduct(book, brandId) {
  const inferredPrintfulVariant = book.podVariantId || book.printfulVariantId || null;
  const inferredLuluPackage = book.podPackageId || book.pod_package_id || book.luluPodPackageId || null;
  const inferredLuluPrintable = book.luluPrintableId || book.printableId || book.printable_id || null;
  const inferredProvider = (() => {
    if (book.fulfillment_provider === 'printful') return 'printful';
    if (book.fulfillment_provider === 'lulu') return 'lulu';
    if (book.podProvider) return String(book.podProvider).toLowerCase();
    if (inferredPrintfulVariant) return 'printful';
    if (inferredLuluPackage || inferredLuluPrintable) return 'lulu';
    return null;
  })();
  const inferredPodVariant = inferredProvider === 'lulu'
    ? inferredLuluPackage
    : inferredPrintfulVariant;
  // Explicit fulfillment_provider overrides heuristic detection
  const inferredFulfillment = (() => {
    if (book.fulfillment_provider === 'stripe_digital') return 'digital';
    if (book.fulfillment_provider === 'printful' || book.fulfillment_provider === 'lulu') return 'pod';
    if (book.fulfillment_provider === 'arxmint') return 'digital';
    if (book.fulfillment_provider === 'manual') return 'physical';
    return book.fulfillment || (inferredProvider ? 'pod' : 'digital');
  })();

  return {
    id: `${brandId}:${book.id}`,
    title: book.title,
    description: book.description || '',
    longDescription: book.longDescription || '',
    price: Math.round((book.price || 0) * 100), // USD cents
    currency: 'USD',
    images: book.coverImage ? [book.coverImage] : [],
    category: book.category || 'Books',
    variants: buildVariants(book),
    fulfillment: inferredFulfillment,
    digitalAssetUrl: book.digitalFile || null,
    podProvider: inferredProvider,
    podProductId: book.podProductId || null,
    podVariantId: inferredPodVariant,
    podPackageId: inferredLuluPackage,
    luluPrintableId: inferredLuluPrintable,
    luluCoverUrl: book.luluCoverUrl || book.coverUrl || book.cover_url || null,
    luluInteriorUrl: book.luluInteriorUrl || book.interiorUrl || book.interior_url || null,
    luluShippingLevel: book.luluShippingLevel || book.shippingMethod || null,
    stock: null, // unlimited for digital
    active: true,
    metadata: {
      author: book.author,
      pages: book.pages,
      rating: book.rating,
      badge: book.badge,
      format: book.format,
      sourceBookId: book.id,
      brandId,
    },
  };
}

function buildVariants(book) {
  if (!book.format || book.format.length <= 1) return [];
  const variants = [];
  if (book.format.includes('hardcover') && book.hardcoverPrice) {
    variants.push({
      id: 'hardcover',
      name: 'Format',
      options: ['hardcover'],
      priceModifier: Math.round((book.hardcoverPrice - book.price) * 100),
    });
  }
  return variants;
}

/**
 * Load all brand catalogs and merge into a single product list.
 */
async function loadAllProducts() {
  const brandsDir = path.join(__dirname, '../../frontend/brands');
  const products = [];

  try {
    const brands = await fs.readdir(brandsDir, { withFileTypes: true });

    for (const brand of brands) {
      if (!brand.isDirectory()) continue;
      // skip test/template brands
      if (brand.name === 'master-templates' || brand.name.includes('test')) continue;

      const catalogPath = path.join(brandsDir, brand.name, 'catalog.json');
      try {
        const raw = await fs.readFile(catalogPath, 'utf8');
        const catalog = JSON.parse(raw);
        if (catalog.books && Array.isArray(catalog.books)) {
          for (const book of catalog.books) {
            products.push(bookToProduct(book, brand.name));
          }
        }
      } catch {
        // brand has no catalog or invalid JSON — skip
      }
    }
  } catch {
    // brands dir doesn't exist
  }

  return products;
}

/**
 * Extract unique categories from product list.
 */
function extractCategories(products) {
  return [...new Set(products.map(p => p.category))].sort();
}

function generateOrderId() {
  return `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeShippingAddress(shippingAddress, customerName, customerEmail) {
  if (!shippingAddress || typeof shippingAddress !== 'object') return null;
  if (!shippingAddress.address1 || !shippingAddress.city || !shippingAddress.country_code || !shippingAddress.zip) {
    return null;
  }

  return {
    name: shippingAddress.name || customerName || 'Customer',
    address1: shippingAddress.address1,
    address2: shippingAddress.address2 || '',
    city: shippingAddress.city,
    state_code: shippingAddress.state_code || shippingAddress.state || '',
    country_code: shippingAddress.country_code,
    zip: shippingAddress.zip,
    email: shippingAddress.email || customerEmail || '',
  };
}

function normalizePodProvider(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

/**
 * Enrich a product with NIP-57 zap fields if eligible (price < $5 USD, digital fulfillment).
 * Sets `zap_address` and `zap_eligible` on the product object (mutates in place).
 */
function enrichWithZapFields(product) {
  const zapAddress = process.env.ZAP_ADDRESS || process.env.LIGHTNING_ADDRESS || null;
  // price is in cents; < 500 = < $5
  const eligible = product.fulfillment === 'digital' && product.price < 500 && zapAddress;
  product.zap_eligible = !!eligible;
  if (eligible) {
    product.zap_address = zapAddress;
  }
}

// ---------------------------------------------------------------------------
// API key authentication for state-changing storefront endpoints (CWE-352)
// External callers (ArxMint, etc.) must include X-Api-Key header for POST requests.
// Set STOREFRONT_API_KEY in .env to enable enforcement; omit to allow unauthenticated access (dev).
// ---------------------------------------------------------------------------

const STOREFRONT_API_KEY = process.env.STOREFRONT_API_KEY;

function requireStorefrontApiKey(req, res, next) {
  if (!STOREFRONT_API_KEY) {
    // Fail closed in production — open access is only safe for dev/legacy
    if (process.env.NODE_ENV === 'production') {
      console.error('[Storefront] STOREFRONT_API_KEY not set — rejecting request in production mode');
      return res.status(401).json({ error: 'API key required' });
    }
    // Dev/legacy mode: allow but warn
    console.warn('[Storefront] STOREFRONT_API_KEY not set — open access (dev mode only)');
    return next();
  }
  const providedKey = req.headers['x-api-key'];
  if (providedKey !== STOREFRONT_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Brand asset endpoints — DB-first with FS fallback for built-in brands.
 *
 * Runtime-scaffolded brands (from Capability Restoration Catalog claims) live
 * in `teneo_marketplace_brands` because @vercel/node serverless has a
 * read-only filesystem. Built-in brands (true-earth, teneo, wealth-wise…)
 * still ship as files under `marketplace/frontend/brands/`.
 *
 * The frontend `store.html` fetches these endpoints first, falling back to
 * `/brands/{slug}/*` static files if needed for legacy paths.
 */

router.get('/brands/:slug/config.json', async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.status(404).json({ error: 'Brand not found' });
  try {
    let brand = null;
    try {
      brand = await brandStore.getBySlug(slug);
    } catch (dbErr) {
      // DB unreachable — fall through to FS. Surface error so we know.
      console.error(`[brandStore.getBySlug] ${slug}: ${dbErr.code || ''} ${dbErr.message}`);
    }
    if (brand?.config) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(brand.config);
    }
    const fallback = await readBuiltinFile(slug, 'config.json');
    if (fallback) {
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', 'application/json');
      return res.send(fallback);
    }
    return res.status(404).json({ error: 'Brand not found' });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to load brand config',
      detail: err.message,
      code: err.code,
    });
  }
});

// Diagnostic endpoint for deployment debugging. Keep disabled unless an
// operator explicitly enables it for a short troubleshooting window.
router.get('/_db_check', async (_req, res) => {
  if (process.env.OPENBAZAAR_ENABLE_DB_DIAGNOSTICS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  const out = {
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasSupabaseDbUrl: Boolean(process.env.SUPABASE_DB_URL),
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    const db = require('../database/database');
    const r = await db.get('SELECT 1 AS ok');
    out.dbQuery = r;
    out.dbMode = 'connected';
  } catch (err) {
    out.dbMode = 'error';
    out.error = err.message;
    out.code = err.code;
    if (process.env.NODE_ENV !== 'production') {
      out.stack = (err.stack || '').split('\n').slice(0, 3).join(' | ');
    }
  }
  res.json(out);
});

router.get('/brands/:slug/catalog.json', async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.status(404).json({ error: 'Catalog not found' });
  try {
    const brand = await brandStore.getBySlug(slug);
    if (brand?.catalog) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(brand.catalog);
    }
    const fallback = await readBuiltinFile(slug, 'catalog.json');
    if (fallback) {
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', 'application/json');
      return res.send(fallback);
    }
    return res.status(404).json({ error: 'Catalog not found' });
  } catch {
    return res.status(500).json({ error: 'Failed to load catalog' });
  }
});

router.get('/brands/:slug/variables.json', async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.status(404).json({ error: 'Variables not found' });
  try {
    const brand = await brandStore.getBySlug(slug);
    if (brand?.variables) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(brand.variables);
    }
    const fallback = await readBuiltinFile(slug, 'variables.json');
    if (fallback) {
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', 'application/json');
      return res.send(fallback);
    }
    return res.status(404).json({ error: 'Variables not found' });
  } catch {
    return res.status(500).json({ error: 'Failed to load variables' });
  }
});

router.get('/brands/:slug/css/theme.css', async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.status(404).send('/* Brand not found */');
  try {
    const brand = await brandStore.getBySlug(slug);
    if (brand?.themeCss) {
      res.set('Content-Type', 'text/css');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(brand.themeCss);
    }
    const fallback = await readBuiltinFile(slug, 'css', 'theme.css');
    if (fallback) {
      res.set('Content-Type', 'text/css');
      res.set('Cache-Control', 'public, max-age=600');
      return res.send(fallback);
    }
    return res.status(404).send('/* Brand theme not found */');
  } catch {
    return res.status(500).send('/* Failed to load theme */');
  }
});

/**
 * GET /api/storefront/catalog
 * Returns full product catalog in standardized schema.
 * Query params: ?category=Books&active=true
 */
router.get('/catalog', async (req, res) => {
  try {
    let products = await loadAllProducts();

    // Filter by category if specified
    if (req.query.category) {
      products = products.filter(p =>
        p.category.toLowerCase() === req.query.category.toLowerCase()
      );
    }

    // Filter by active status (default: only active)
    if (req.query.active !== 'false') {
      products = products.filter(p => p.active);
    }

    // Enrich with sat pricing (best-effort; skipped if CoinGecko is unavailable)
    const btcRate = await getBtcUsdRate();
    if (btcRate) {
      for (const product of products) {
        product.price_sats = Math.ceil((product.price / 100) / btcRate * 1e8);
      }
    }

    // Enrich with NIP-57 zap fields for eligible low-value digital products
    for (const product of products) {
      enrichWithZapFields(product);
    }

    const storeId = process.env.STORE_ID || 'openbazaar-default';
    const storeName = process.env.STORE_NAME || 'OpenBazaar Store';

    res.json({
      storeId,
      storeName,
      btcUsdRate: btcRate || null,
      products,
      categories: extractCategories(products),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error loading catalog:', error);
    res.status(500).json({ error: 'Failed to load catalog' });
  }
});

/**
 * GET /api/storefront/catalog/:category
 * Products filtered by category.
 */
router.get('/catalog/:category', async (req, res) => {
  try {
    const products = await loadAllProducts();
    const filtered = products.filter(p =>
      p.category.toLowerCase() === req.params.category.toLowerCase() && p.active
    );

    res.json({
      category: req.params.category,
      products: filtered,
      count: filtered.length,
    });
  } catch (error) {
    console.error('Error loading category:', error);
    res.status(500).json({ error: 'Failed to load category' });
  }
});

/**
 * GET /api/storefront/product/:id
 * Single product detail. ID format: brandId:productId
 */
router.get('/product/:id', async (req, res) => {
  try {
    const products = await loadAllProducts();
    const product = products.find(p => p.id === req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const btcRate = await getBtcUsdRate();
    if (btcRate) {
      product.price_sats = Math.ceil((product.price / 100) / btcRate * 1e8);
    }

    enrichWithZapFields(product);

    res.json(product);
  } catch (error) {
    console.error('Error loading product:', error);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

/**
 * POST /api/storefront/checkout
 * Create a checkout session via the configured payment provider.
 *
 * Body: { productId, provider: 'arxmint' | 'stripe', customerEmail? }
 * Returns: { checkoutUrl, sessionId }
 */
router.post('/checkout', requireStorefrontApiKey, async (req, res) => {
  try {
    const {
      productId,
      provider,
      customerEmail,
      customerName,
      shippingAddress,
      shippingMethod,
      quantity = 1,
    } = req.body || {};

    if (!productId) {
      return res.status(400).json({ error: 'productId required' });
    }

    // Look up the product
    const products = await loadAllProducts();
    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const normalizedShipping = normalizeShippingAddress(shippingAddress, customerName, customerEmail);
    if ((product.fulfillment === 'physical' || product.fulfillment === 'pod') && !normalizedShipping) {
      return res.status(400).json({
        error: 'shippingAddress with address1/city/country_code/zip is required for physical/POD products',
      });
    }

    const publicUrl = process.env.SITE_URL || process.env.PUBLIC_URL || 'http://localhost:3001';
    const callbackUrl = `${publicUrl}/api/storefront/fulfill`;

    if (provider === 'arxmint') {
      if (!arxmintProvider.enabled) {
        return res.status(503).json({ error: 'ArxMint payments not configured' });
      }

      const result = await arxmintProvider.createCheckout({
        amount: product.price,
        currency: product.currency,
        memo: product.title,
        productId: product.id,
        merchantId: arxmintProvider.merchantId,
        callbackUrl,
        successUrl: `${publicUrl}/success.html`,
        cancelUrl: `${publicUrl}/cancel.html`,
        customerEmail,
      });

      // Persist a pending internal order now so webhook-driven fulfillment has context.
      const orderId = generateOrderId();
      const fallbackEmail = customerEmail || `no-email+${orderId}@local.invalid`;
      await orderService.createOrder({
        orderId,
        stripeSessionId: result.sessionId,
        customerEmail: fallbackEmail,
        customerName: customerName || null,
        bookId: product.id,
        bookTitle: product.title,
        bookAuthor: product.metadata?.author || 'Unknown',
        format: product.fulfillment || 'digital',
        price: Number(product.price || 0) / 100,
        currency: product.currency || 'USD',
        metadata: {
          source: 'storefront',
          paymentProvider: 'arxmint',
          productId: product.id,
          quantity: Number(quantity) || 1,
          shippingAddress: normalizedShipping,
          shippingMethod: shippingMethod || null,
          podProvider: normalizePodProvider(product.podProvider),
          podVariantId: product.podVariantId || null,
          podPackageId: product.podPackageId || null,
          luluPrintableId: product.luluPrintableId || null,
          luluCoverUrl: product.luluCoverUrl || null,
          luluInteriorUrl: product.luluInteriorUrl || null,
          luluShippingLevel: product.luluShippingLevel || null,
        },
      });

      return res.json({
        ...result,
        orderId,
      });
    }

    // Default: return info for Stripe checkout (existing flow handles this)
    return res.json({
      message: 'Use /api/checkout for Stripe payments',
      productId: product.id,
      price: product.price,
      currency: product.currency,
    });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

/**
 * POST /api/storefront/fulfill
 * Webhook endpoint for payment providers to confirm payment and trigger fulfillment.
 *
 * Body (from ArxMint):
 * {
 *   sessionId: string,
 *   productId: string,
 *   paymentProvider: 'arxmint',
 *   amountSats: number,
 *   paidAt: string (ISO date),
 *   customerEmail?: string
 * }
 */
async function handleFulfill(req, res) {
  try {
    // Parse body — may arrive as raw buffer (for signature verification) or parsed JSON
    let body;
    if (Buffer.isBuffer(req.body)) {
      body = JSON.parse(req.body.toString());
    } else {
      body = req.body;
    }

    // Fail closed in production when no webhook secret is configured
    if (process.env.NODE_ENV === 'production' && !arxmintProvider.webhookSecret) {
      console.error('[Fulfill] ARXMINT_WEBHOOK_SECRET not set — rejecting unauthenticated fulfill request');
      return res.status(401).json({ error: 'Webhook authentication not configured' });
    }

    // Always verify signature when secret is configured, regardless of body type (CWE-306 fix)
    if (arxmintProvider.webhookSecret) {
      const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(body));
      const isValid = arxmintProvider.verifyWebhook(bodyBuffer, req.headers);
      if (!isValid) {
        console.warn('[Fulfill] Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const {
      sessionId,
      orderId: providedOrderId,
      productId: providedProductId,
      paymentProvider,
      amountSats,
      paidAt,
      customerEmail,
      customerName,
      shippingAddress,
      shippingMethod,
      quantity = 1,
    } = body || {};

    if (!paymentProvider) {
      return res.status(400).json({ error: 'paymentProvider required' });
    }

    console.log(`[Fulfill] Payment confirmed: provider=${paymentProvider} product=${providedProductId || 'n/a'} amount=${amountSats || 'n/a'} sats`);

    // Rehydrate internal order context when available
    let existingOrder = null;
    if (providedOrderId) {
      existingOrder = await orderService.getOrder(providedOrderId);
    } else if (sessionId) {
      existingOrder = await orderService.getOrderBySessionId(sessionId);
    }

    const existingMeta = parseJsonObject(existingOrder?.metadata);
    const effectiveOrderId = existingOrder?.order_id || providedOrderId || generateOrderId();
    const effectiveProductId = providedProductId || existingOrder?.book_id;
    const effectiveCustomerEmail = customerEmail || existingOrder?.customer_email || `no-email+${effectiveOrderId}@local.invalid`;
    const effectiveCustomerName = customerName || existingOrder?.customer_name || '';
    const effectiveShipping = normalizeShippingAddress(
      shippingAddress || existingMeta.shippingAddress,
      effectiveCustomerName,
      effectiveCustomerEmail
    );

    if (!effectiveProductId) {
      return res.status(400).json({ error: 'productId required (or resolvable from orderId/sessionId)' });
    }

    // Look up product for fulfillment details
    const products = await loadAllProducts();
    const product = products.find(p => p.id === effectiveProductId);

    if (!product) {
      console.error(`[Fulfill] Product not found: ${effectiveProductId}`);
      return res.status(404).json({ error: 'Product not found' });
    }

    // Ensure internal order exists
    if (!existingOrder) {
      await orderService.createOrder({
        orderId: effectiveOrderId,
        stripeSessionId: sessionId || null,
        customerEmail: effectiveCustomerEmail,
        customerName: effectiveCustomerName || null,
        bookId: product.id,
        bookTitle: product.title,
        bookAuthor: product.metadata?.author || 'Unknown',
        format: product.fulfillment || 'digital',
        price: Number(product.price || 0) / 100,
        currency: product.currency || 'USD',
        metadata: {
          source: 'storefront',
          paymentProvider,
          quantity: Number(quantity) || 1,
          shippingAddress: effectiveShipping,
          shippingMethod: shippingMethod || existingMeta.shippingMethod || null,
          podProvider: normalizePodProvider(product.podProvider) || normalizePodProvider(existingMeta.podProvider),
          podVariantId: product.podVariantId || null,
          podPackageId: product.podPackageId || null,
          luluPrintableId: product.luluPrintableId || null,
          luluCoverUrl: product.luluCoverUrl || null,
          luluInteriorUrl: product.luluInteriorUrl || null,
          luluShippingLevel: product.luluShippingLevel || null,
        },
      });
      existingOrder = await orderService.getOrder(effectiveOrderId);
    }

    const paymentMeta = {
      ...existingMeta,
      paymentProvider,
      amountSats: amountSats || null,
      paidAt: paidAt || new Date().toISOString(),
      shippingAddress: effectiveShipping || existingMeta.shippingAddress || null,
      shippingMethod: shippingMethod || existingMeta.shippingMethod || null,
      podProvider: normalizePodProvider(product.podProvider) || normalizePodProvider(existingMeta.podProvider),
      podVariantId: product.podVariantId || existingMeta.podVariantId || null,
      podPackageId: product.podPackageId || existingMeta.podPackageId || null,
      luluPrintableId: product.luluPrintableId || existingMeta.luluPrintableId || null,
      luluCoverUrl: product.luluCoverUrl || existingMeta.luluCoverUrl || null,
      luluInteriorUrl: product.luluInteriorUrl || existingMeta.luluInteriorUrl || null,
      luluShippingLevel: product.luluShippingLevel || existingMeta.luluShippingLevel || null,
    };

    // Fulfill based on product type
    if (product.fulfillment === 'digital' && product.digitalAssetUrl) {
      const completed = await orderService.completeOrder(effectiveOrderId, sessionId || `ext_${Date.now()}`);
      const publicUrl = process.env.SITE_URL || process.env.PUBLIC_URL || 'http://localhost:3001';
      const downloadUrl = `${publicUrl}/api/download/${completed.downloadToken}`;

      console.log(`[Fulfill] Digital delivery: order=${effectiveOrderId} product=${product.title}`);

      // Send download email if we have customer email
      if (effectiveCustomerEmail && !effectiveCustomerEmail.endsWith('@local.invalid')) {
        try {
          await emailService.sendDownloadEmail({
            userEmail: effectiveCustomerEmail,
            bookTitle: product.title,
            bookAuthor: product.metadata?.author || 'Unknown',
            downloadUrl,
            orderId: effectiveOrderId,
          });
        } catch (emailErr) {
          console.error('[Fulfill] Email send failed:', emailErr.message);
        }
      }

      await orderService.updateOrderStatus(effectiveOrderId, {
        status: 'completed',
        payment_status: 'paid',
        fulfillment_status: 'fulfilled',
        metadata: JSON.stringify(paymentMeta),
      });

      // State machine: pending→processing→completed (non-fatal for existing DBs)
      await orderService.updateOrderState(effectiveOrderId, 'processing', { provider: paymentProvider })
        .then(() => orderService.updateOrderState(effectiveOrderId, 'completed', { provider: paymentProvider, fulfillment: 'digital' }))
        .catch(err => console.warn('[state-machine] fulfill digital state transition failed (non-fatal):', err.message));

      return res.json({
        success: true,
        orderId: effectiveOrderId,
        fulfillment: 'digital',
        downloadToken: completed.downloadToken,
        message: 'Order fulfilled — download link sent',
      });
    }

    if (product.fulfillment === 'physical' || product.fulfillment === 'pod') {
      if (!effectiveShipping) {
        return res.status(400).json({ error: 'shippingAddress is required for physical/POD fulfillment' });
      }

      await orderService.updateOrderStatus(effectiveOrderId, {
        status: 'completed',
        payment_status: 'paid',
        fulfillment_status: 'processing',
        order_type: product.fulfillment === 'pod' ? 'physical' : product.fulfillment,
        contains_physical: 1,
        shipping_address: JSON.stringify(effectiveShipping),
        shipping_method: paymentMeta.shippingMethod || paymentMeta.luluShippingLevel || null,
        metadata: JSON.stringify(paymentMeta),
      });

      // State machine: pending→processing (non-fatal for existing DBs)
      await orderService.updateOrderState(effectiveOrderId, 'processing', { provider: paymentProvider, fulfillment: product.fulfillment })
        .catch(err => console.warn('[state-machine] fulfill physical state transition failed (non-fatal):', err.message));

      if (product.fulfillment === 'pod') {
        const providerName = normalizePodProvider(product.podProvider || paymentMeta.podProvider) || 'printful';
        const providerParams = {
          orderId: effectiveOrderId,
          quantity: Number(quantity) || 1,
          shippingAddress: effectiveShipping,
          confirm: true,
        };

        if (providerName === 'printful') {
          const variantId = product.podVariantId || paymentMeta.podVariantId;
          if (!variantId) {
            return res.status(422).json({ error: 'podVariantId is required for Printful POD fulfillment' });
          }
          const variantIdNum = Number(variantId);
          if (!Number.isInteger(variantIdNum) || variantIdNum <= 0) {
            return res.status(422).json({ error: 'podVariantId must be a positive integer (valid Printful variant ID)' });
          }
          providerParams.variantId = variantIdNum;
        } else if (providerName === 'lulu') {
          const podPackageId = product.podPackageId || paymentMeta.podPackageId || product.podVariantId || paymentMeta.podVariantId;
          const luluPrintableId = product.luluPrintableId || paymentMeta.luluPrintableId || null;
          if (!podPackageId && !luluPrintableId) {
            return res.status(422).json({ error: 'podPackageId or luluPrintableId is required for Lulu POD fulfillment' });
          }

          const sourceBookId = product.metadata?.sourceBookId || (product.id.includes(':') ? product.id.split(':')[1] : product.id);
          const sourceFormat = Array.isArray(product.metadata?.format)
            ? product.metadata.format[0]
            : (product.metadata?.format || 'print_trade');

          providerParams.shippingMethod = String(paymentMeta.shippingMethod || paymentMeta.luluShippingLevel || 'MAIL').toUpperCase();
          providerParams.lineItems = [
            {
              bookId: sourceBookId,
              formatType: sourceFormat,
              title: product.title,
              quantity: Number(quantity) || 1,
              podPackageId,
              printableId: luluPrintableId || undefined,
              coverUrl: product.luluCoverUrl || paymentMeta.luluCoverUrl || undefined,
              interiorUrl: product.luluInteriorUrl || paymentMeta.luluInteriorUrl || undefined,
              pageCount: Number(product.metadata?.pages) || undefined,
            },
          ];
        } else {
          return res.status(422).json({ error: `Unsupported POD provider: ${providerName}` });
        }

        const fulfillmentResult = await fulfillmentService.createOrder(providerName, providerParams);

        const fulfillmentUpdates = {
          fulfillment_status: 'pod_submitted',
          metadata: JSON.stringify({
            ...paymentMeta,
            podSubmittedAt: new Date().toISOString(),
            podProvider: providerName,
            podOrderId: fulfillmentResult.orderId,
            podPrintJobId: fulfillmentResult.printJobId || null,
          }),
        };
        if (providerName === 'printful' && fulfillmentResult.orderId) {
          fulfillmentUpdates.printful_order_id = String(fulfillmentResult.orderId);
        }
        if (providerName === 'lulu' && (fulfillmentResult.printJobId || fulfillmentResult.orderId)) {
          fulfillmentUpdates.lulu_print_job_id = String(fulfillmentResult.printJobId || fulfillmentResult.orderId);
        }

        await orderService.updateOrderStatus(effectiveOrderId, fulfillmentUpdates);

        return res.json({
          success: true,
          orderId: effectiveOrderId,
          fulfillment: 'pod',
          provider: providerName,
          providerOrderId: fulfillmentResult.orderId,
          printJobId: fulfillmentResult.printJobId || null,
          status: fulfillmentResult.status,
          message: 'POD order submitted to fulfillment provider',
        });
      }

      // Non-POD physical fulfillment: keep pending for manual flow
      await orderService.updateOrderStatus(effectiveOrderId, {
        fulfillment_status: 'physical_pending',
      });

      return res.json({
        success: true,
        orderId: effectiveOrderId,
        fulfillment: product.fulfillment,
        message: 'Order recorded — physical fulfillment pending',
        requiresShipping: true,
      });
    }

    // Fallback
    await orderService.updateOrderStatus(effectiveOrderId, {
      status: 'completed',
      payment_status: 'paid',
      fulfillment_status: 'pending',
      metadata: JSON.stringify(paymentMeta),
    });

    return res.json({
      success: true,
      orderId: effectiveOrderId,
      fulfillment: product.fulfillment || 'unknown',
      message: 'Order recorded',
    });
  } catch (error) {
    console.error('[Fulfill] Error:', error);
    res.status(500).json({ error: 'Fulfillment failed' });
  }
}

// Register /fulfill route using the named handler (also exported for /api/arxmint/webhook alias)
router.post('/fulfill', express.raw({ type: 'application/json' }), handleFulfill);

/**
 * POST /api/storefront/zap-unlock
 * Accept a NIP-57 kind 9735 zap receipt, verify it, and return a one-time download token.
 *
 * This endpoint is CSRF-exempt (listed in server.js csrfExcludePaths) because callers
 * are Lightning-native wallets / NIP-07 browser extensions that cannot provide a session cookie.
 *
 * Body:   { kind9735Event: object, productId: string }
 * Returns: { success: true, downloadToken, downloadUrl, orderId, amountSats }
 *   or 402 Payment Required with { error: string }
 */
router.post('/zap-unlock', async (req, res) => {
  try {
    const { kind9735Event, productId } = req.body || {};

    if (!kind9735Event || !productId) {
      return res.status(400).json({ error: 'kind9735Event and productId required' });
    }

    // Load and validate product
    const products = await loadAllProducts();
    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Zap unlock is only valid for low-value digital products
    if (product.price >= 500) {
      return res.status(403).json({ error: 'Zap unlock only available for products under $5' });
    }
    if (product.fulfillment !== 'digital') {
      return res.status(403).json({ error: 'Zap unlock only available for digital products' });
    }

    // Determine minimum expected sats from live BTC/USD rate
    const btcRate = await getBtcUsdRate();
    const expectedSats = btcRate
      ? Math.ceil((product.price / 100) / btcRate * 1e8)
      : 1;

    // Verify the NIP-57 zap receipt
    const result = zapService.verifyZapReceipt(kind9735Event, expectedSats, productId);
    if (!result.valid) {
      return res.status(402).json({ error: result.error || 'Invalid zap receipt' });
    }

    // Create an order record and generate a one-time download token
    const orderId = generateOrderId();
    const zapperLabel = result.zapperPubkey
      ? `npub:${result.zapperPubkey.slice(0, 8)}`
      : 'Zap buyer';
    const zapperEmail = `zap+${orderId}@nostr.invalid`;

    await orderService.createOrder({
      orderId,
      stripeSessionId: `zap_${kind9735Event.id || Date.now()}`,
      customerEmail: zapperEmail,
      customerName: zapperLabel,
      bookId: product.id,
      bookTitle: product.title,
      bookAuthor: product.metadata?.author || 'Unknown',
      format: 'digital',
      price: Number(product.price || 0) / 100,
      currency: 'USD',
      metadata: {
        source: 'zap-unlock',
        paymentMethod: 'nip57-zap',
        amountSats: result.amountSats,
        zapperPubkey: result.zapperPubkey || null,
        zapReceiptId: kind9735Event.id || null,
      },
    });

    const completed = await orderService.completeOrder(orderId, `zap_${kind9735Event.id || Date.now()}`);
    const publicUrl = process.env.SITE_URL || process.env.PUBLIC_URL || 'http://localhost:3001';
    const downloadUrl = `${publicUrl}/api/download/${completed.downloadToken}`;

    // State machine: pending → processing → completed (non-fatal)
    await orderService.updateOrderState(orderId, 'processing', { provider: 'nip57-zap' })
      .then(() => orderService.updateOrderState(orderId, 'completed', { provider: 'nip57-zap', fulfillment: 'zap-digital' }))
      .catch(err => console.warn('[zap-unlock] state-machine transition failed (non-fatal):', err.message));

    console.log(`[zap-unlock] Unlocked product="${product.title}" orderId=${orderId} sats=${result.amountSats}`);

    return res.json({
      success: true,
      downloadToken: completed.downloadToken,
      downloadUrl,
      orderId,
      amountSats: result.amountSats,
    });
  } catch (error) {
    console.error('[zap-unlock] Error:', error);
    res.status(500).json({ error: 'Zap unlock failed' });
  }
});

/**
 * GET /api/zap/receipt
 *
 * Poll a Nostr relay for a kind 9735 zap receipt matching a zap request event ID.
 * The frontend calls this after paying a Lightning invoice, polling every 3 seconds.
 *
 * Query params:
 *   zap_request_id {string} - Event ID of the kind 9734 zap request (required)
 *   relay           {string} - wss:// relay URL (optional, defaults to env ZAP_RELAY)
 *
 * Responses:
 *   { status: "found",   receipt: {...} }  — kind 9735 event found
 *   { status: "pending" }                  — not found yet (poll again)
 *   { status: "timeout" }                  — relay did not respond in time
 */
router.get('/zap/receipt', async (req, res) => {
  const { zap_request_id: zapRequestId, relay } = req.query;

  if (!zapRequestId || typeof zapRequestId !== 'string' || !/^[0-9a-f]{64}$/i.test(zapRequestId)) {
    return res.status(400).json({ error: 'zap_request_id must be a 64-character hex string' });
  }

  const relayUrl = (relay && relay.startsWith('wss://'))
    ? relay
    : (process.env.ZAP_RELAY || 'wss://relay.damus.io');

  try {
    // Short timeout: client will poll again; keeps connections short-lived
    const receipt = await zapService.pollForZapReceipt(relayUrl, zapRequestId, 8000);

    if (!receipt) {
      return res.json({ status: 'pending' });
    }

    return res.json({ status: 'found', receipt });
  } catch (err) {
    console.error('[zap/receipt] Poll error:', err.message);
    return res.json({ status: 'timeout' });
  }
});

module.exports = router;
module.exports.handleFulfill = handleFulfill;
