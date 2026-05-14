// marketplace/backend/server.js
require('dotenv').config();

// Environment variable validation
function validateEnvironment() {
    if (process.env.NODE_ENV === 'production') {
        const fatal = [];
        if (!process.env.ADMIN_PASSWORD_HASH) {
            fatal.push('ADMIN_PASSWORD_HASH must be set in production. Run: node scripts/generate-password-hash.js --generate');
        }
        if (!process.env.SESSION_SECRET) {
            fatal.push('SESSION_SECRET must be set in production (min 32 chars)');
        } else if (process.env.SESSION_SECRET.length < 32) {
            fatal.push('SESSION_SECRET must be at least 32 characters in production');
        }
        if (fatal.length > 0) {
            console.error('FATAL: Missing required environment configuration:');
            fatal.forEach(msg => console.error(' -', msg));
            process.exit(1);
        }
    } else {
        if (!process.env.ADMIN_PASSWORD_HASH) {
            console.warn('⚠️  ADMIN_PASSWORD_HASH not set. Admin login will fail until configured.');
        }
        if (!process.env.SESSION_SECRET) {
            const crypto = require('crypto');
            process.env.SESSION_SECRET = crypto.randomBytes(64).toString('hex');
            console.warn('⚠️  Using auto-generated session secret (dev only). Set SESSION_SECRET in production!');
        }
    }
    
    // Warn if SQLite is used in production (non-persistent on most PaaS platforms)
    if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
        const dbPath = process.env.DATABASE_PATH || '/tmp/marketplace.db';
        console.warn(`⚠️  WARNING: Running SQLite in production (${dbPath}). Data will be lost on container restart.`);
        console.warn('   Set DATABASE_URL (PostgreSQL) for persistent storage in production.');
    }

    // Warn about optional but important variables
    const importantVars = [
        'STRIPE_SECRET_KEY',
        'STRIPE_PUBLISHABLE_KEY',
        'EMAIL_USER'
    ];

    if (!process.env.OPENAI_API_KEY) {
        console.warn('⚠️  OPENAI_API_KEY not set — AI Discovery will use keyword search fallback');
    }
    
    const missingImportant = importantVars.filter(varName => !process.env[varName]);
    if (missingImportant.length > 0) {
        console.warn('⚠️  WARNING: Missing optional environment variables:');
        missingImportant.forEach(varName => {
            console.warn(`  - ${varName}`);
        });
        console.warn('Some features may not work properly.\n');
    }
}

validateEnvironment();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => process.env.SESSION_SECRET,
    getSessionIdentifier: (req) => (req.session ? req.session.id : 'anonymous'),
    cookieName: process.env.NODE_ENV === 'production'
        ? '__Host-psifi.x-csrf-token'
        : 'psifi.x-csrf-token',
    cookieOptions: { sameSite: 'strict', secure: process.env.NODE_ENV === 'production' },
    size: 64,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});
const crypto = require('crypto');
const brandRoutes = require('./routes/brandRoutes');
const checkoutRoutes = require('./routes/checkout');
const { router: checkoutMixedRoutes } = require('./routes/checkoutMixed');
const cryptoCheckoutRoutes = require('./routes/cryptoCheckout');
const catalogRoutes = require('./routes/catalogRoutes');
const downloadRoutes = require('./routes/downloadRoutes');
const luluAdminRoutes = require('./routes/luluAdmin');
const luluWebhookRoutes = require('./routes/luluWebhooks');
const adminRoutes = require('./routes/adminRoutes');
const networkRoutes = require('./routes/networkRoutes');
const configRoutes = require('./routes/configRoutes');
const publishedBooksRoutes = require('./routes/publishedBooks');
const publisherProfileRoutes = require('./routes/publisherProfiles');
const bookAnalyticsRoutes = require('./routes/bookAnalytics');
const digestRoutes = require('./routes/digestRoutes');
const manualEnhancementRoutes = require('./routes/manualEnhancement');
const webhookRoutes = require('./routes/webhooks');
const aiDiscoveryRoutes = require('./routes/aiDiscovery');
const censorshipTrackerRoutes = require('./routes/censorshipTracker');
// const nftRoutes = require('./routes/nft'); // NOT IMPLEMENTED — removed from roadmap ("No proven demand")
const authRoutes = require('./routes/auth');
const couponsRoutes = require('./routes/couponsRoutes');
const emailTrackingRoutes = require('./routes/emailTracking');
const emailMarketingRoutes = require('./routes/emailMarketing');
const storefrontRoutes = require('./routes/storefront');
const { handleFulfill: handleArxMintWebhook } = require('./routes/storefront');
const machineRoutes = require('./routes/machine');
const agentRoutes = require('./routes/agentRoutes');
const l402Routes = require('./routes/l402Routes');
const printfulWebhookRoutes = require('./routes/printfulWebhooks');
const printfulAdminRoutes = require('./routes/printfulAdmin');
const licenseRoutes = require('./routes/licenseRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const hostingRoutes = require('./routes/hostingRoutes');
const wellKnownRoutes = require('./routes/wellKnownRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const merchantFulfillmentRoutes = require('./routes/merchantFulfillment');
const aiInvokeRoutes = require('./routes/aiInvoke');

// Funnel builder routes
const funnelRoutes = require('../../funnel-module/backend/routes/funnels');

// Course platform routes
const courseRoutes = require('./routes/courseRoutes');
const quizRoutes = require('./routes/quiz');
const appStoreRoutes = require('./routes/appStore');

const { safeMessage } = require('./utils/validate');
const axios = require('axios');
const networkConfig = require('./config/network');

const app = express();

// Per-request CSP nonce — must run before helmet so res.locals.cspNonce is available
app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

// Security headers (CWE-693)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "https://js.stripe.com"],
            styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.stripe.com"]
        }
    },
    crossOriginEmbedderPolicy: { policy: 'credentialless' }  // Chrome 96+, Firefox 119+; compatible with Stripe.js (credentialless relaxes COEP for unauthenticated cross-origin requests)
}));

// Import auth middleware
const { requireHTTPS } = require('./middleware/auth');

// Force HTTPS in production
app.use(requireHTTPS);

// Session configuration
// SESSION_SECRET is guaranteed to be set by validateEnvironment() above:
//   - production: exits with FATAL error if missing or < 32 chars (CWE-330)
//   - development: auto-generated random secret if not provided
const sessionSecret = process.env.SESSION_SECRET;
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true, // Prevent XSS attacks
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'strict' // CSRF protection
    },
    name: 'teneo.sid' // Custom session name
}));

// cookie-parser: required by csrf-csrf (must be after session, before CSRF middleware)
app.use(cookieParser());

// Middleware - Updated CORS for Teneo domains
app.use(cors({
    origin: [
        'https://teneo.io',
        'https://www.teneo.io',
        'https://staging.teneo.io',
        'https://arxmint.com',        // ArxMint bazaar integration
        'https://www.arxmint.com',
        'http://localhost:3333',  // Teneo development
        'http://localhost:3000',  // ArxMint local dev
        process.env.FRONTEND_URL || 'http://localhost:3000'  // Keep backward compatibility
    ],
    credentials: true, // Allow cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Service-Key', 'x-service-key']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// CSRF protection for all POST/PUT/DELETE routes except specific endpoints
const csrfExcludePaths = [
    '/api/checkout/webhook',
    '/api/checkout/mixed',
    '/api/lulu/webhook',
    '/api/crypto/btcpay/webhook', // BTCPay payment webhook
    '/api/storefront/fulfill',     // ArxMint fulfillment webhook
    '/api/arxmint/webhook',        // ArxMint dedicated webhook alias
    '/api/machine/webhook',        // Machine-payable ArxMint webhook
    '/api/webhooks/printful',      // Printful shipment/order webhooks
    '/webhooks', // Orchestrator webhooks
    '/api/auth/login',            // Magic link initiator — session created via GET verify
    '/api/auth/register',         // Magic link initiator — session created via GET verify
    '/api/auth/logout',           // Session destroy — protected by requireAuth, low CSRF risk
    '/api/auth/nostr/verify',     // Nostr NIP-98 signed event — self-authenticated
    '/api/subscriptions/webhook', // Stripe subscription webhook
    '/api/hosting/webhook',       // Stripe hosting subscription webhook
    '/api/storefront/zap-unlock', // NIP-57 zap receipt — self-authenticated via Schnorr sig
    '/api/l402',                  // L402 Lightning auth — self-authenticated via preimage, not session
    '/api/agent',                 // Agent API — authenticated via NIP-98 or API key, not session cookies
    '/api/ai-invoke',             // TE ecosystem service-key calls, not browser session cookies
]; // Webhook endpoints need to be excluded

app.use((req, res, next) => {
    // Skip CSRF entirely in test environment
    if (process.env.NODE_ENV === 'test') {
        return next();
    }
    // Skip CSRF for webhook endpoints
    if (csrfExcludePaths.some(path => req.path.startsWith(path))) {
        return next();
    }
    // Skip CSRF for GET requests and public API endpoints
    // Storefront and app-store are external APIs: exempt GET (read-only) but require API key for POST/PUT/DELETE (handled in the router)
    if (req.method === 'GET' ||
        req.path.startsWith('/api/health') ||
        req.path.startsWith('/api/network/status') ||
        ((req.path.startsWith('/api/apps') || req.path.startsWith('/api/storefront') || req.path.startsWith('/api/machine')) && req.method === 'GET') ||
        req.path.startsWith('/api/machine/order') // machine order creation uses NIP-98 auth, not session cookies
    ) {
        return next();
    }
    // Apply CSRF protection to all other routes
    doubleCsrfProtection(req, res, next);
});

// Endpoint to get CSRF token (generates token + sets CSRF cookie)
app.get('/api/csrf-token', (req, res) => {
    const csrfToken = generateCsrfToken(req, res);
    res.json({ csrfToken });
});
// NIP-05 DNS verification — must come before other routes so /.well-known/nostr.json is served
app.use('/.well-known', wellKnownRoutes);

app.use('/api/brands', brandRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/checkout/mixed', checkoutMixedRoutes);
app.use('/api/crypto', cryptoCheckoutRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/lulu', luluAdminRoutes);
app.use('/api', luluWebhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/printful', printfulAdminRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/config', configRoutes);
app.use('/api/published', publishedBooksRoutes);
app.use('/api/publishers', publisherProfileRoutes);
app.use('/api/books', bookAnalyticsRoutes);
app.use('/api/digest', digestRoutes);
app.use('/api/manual-enhancement', manualEnhancementRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api/discovery', aiDiscoveryRoutes);
app.use('/api/censorship', censorshipTrackerRoutes);
// app.use('/api/nft', nftRoutes); // NOT IMPLEMENTED — removed from roadmap

app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/coupons', couponsRoutes);
app.use('/api/license', licenseRoutes);
app.use('/api/referral', require('./routes/referralRoutes'));
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/hosting', hostingRoutes);

// Referral attribution — capture ?ref= query param into session so checkout can pick it up
// Runs after session middleware, before route handlers
app.use((req, res, next) => {
    const ref = req.query.ref;
    if (ref && typeof ref === 'string' && ref.length <= 20 && !req.session.referralCode) {
        // Uppercase + strip non-alphanumeric chars to match referral code format
        req.session.referralCode = ref.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 20);
    }
    next();
});

app.use('/api/email', emailTrackingRoutes);
app.use('/api/email-marketing', emailMarketingRoutes);

// Funnel builder API
app.use('/api/funnels', funnelRoutes);

// Course platform API
app.use('/api/courses', courseRoutes);
app.use('/api/quizzes', quizRoutes);

// Agent App Store
app.use('/api/apps', appStoreRoutes);

// AI Store Builder
app.use('/api/store-builder', require('./routes/storeBuilder'));

// Public store pages — GET /store/:slug serves published store HTML (no auth required)
app.get('/store/:slug', async (req, res) => {
  try {
    const db = require('./database/database');
    const slug = req.params.slug;
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(404).send('<h1>Store not found</h1>');
    }
    const store = await db.get(
      "SELECT html, config FROM stores WHERE slug = ? AND status = 'published'",
      [slug]
    );
    if (!store) return res.status(404).send('<h1>Store not found</h1>');
    res.set('Content-Type', 'text/html');
    res.send(store.html);
  } catch (err) {
    res.status(500).send('<h1>Internal Server Error</h1>');
  }
});

// L402 Lightning-native download endpoints — AI agents pay-and-retrieve via Lightning
app.use('/api/l402', l402Routes);

// Machine-payable endpoints — AI agent commerce (Lightning invoices, NIP-98 auth)
app.use('/api/machine', machineRoutes);

// Agent API — structured catalog, quoting, and purchasing for AI agents
app.use('/api/agent', agentRoutes);

// TE ecosystem service-key capability endpoints
app.use('/api/ai-invoke', aiInvokeRoutes);

// Storefront API (standardized catalog + fulfillment for ArxMint bazaar integration)
app.use('/api/storefront', storefrontRoutes);
// ArxMint dedicated webhook alias — same handler as /api/storefront/fulfill
app.post('/api/arxmint/webhook', express.raw({ type: 'application/json' }), handleArxMintWebhook);
app.use('/api/webhooks', printfulWebhookRoutes);
app.use('/api/merchant/fulfillment', merchantFulfillmentRoutes);

// Public certificate verification (separate mount so it doesn't need /api/courses prefix)
const { getCertificate } = require('./services/certificateService');
app.get('/api/verify/certificate/:certId', async (req, res) => {
    try {
        const cert = await getCertificate(req.params.certId);
        if (!cert) return res.status(404).json({ success: false, error: 'Certificate not found' });
        res.json({
            success: true,
            valid: true,
            course: cert.course_title,
            issued_at: cert.issued_at
            // user_email intentionally omitted from public response
        });
    } catch (error) {
        console.error('Verify certificate error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify certificate' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'openbazaar-ai-api'
    });
});

// Stripe-specific health endpoint (also accessible via /api/checkout/health/stripe)
app.get('/api/health/stripe', async (req, res) => {
    const { checkStripeHealth } = require('./services/stripeHealthService');
    const health = await checkStripeHealth();
    const statusCode = health.healthy ? 200 : 503;
    res.status(statusCode).json({
        healthy: health.healthy,
        lastChecked: health.lastChecked ? new Date(health.lastChecked).toISOString() : null,
        ...(health.error && { error: health.error }),
    });
});

// Note: /api/brands is handled by brandRoutes router

// Get books (optionally filtered by brand)
app.get('/api/books', async (req, res) => {
    try {
        const { brand, limit, offset } = req.query;
        const brandsPath = path.join(__dirname, '..', 'frontend', 'brands');
        let allBooks = [];

        if (brand && brand !== 'all') {
            // Sanitize brand to prevent path traversal (CWE-22)
            const brandsBase = path.resolve(brandsPath);
            const safe = path.basename(brand);
            if (!safe || safe === '.' || safe === '..') {
                return res.status(400).json({ success: false, error: 'Invalid brand' });
            }
            const resolved = path.resolve(brandsBase, safe);
            if (!resolved.startsWith(brandsBase + path.sep) && resolved !== brandsBase) {
                return res.status(400).json({ success: false, error: 'Invalid brand' });
            }
            // Get books from specific brand
            const catalogPath = path.join(brandsBase, safe, 'catalog.json');
            try {
                const catalogContent = await fs.readFile(catalogPath, 'utf8');
                const catalog = JSON.parse(catalogContent);
                allBooks = catalog.books || [];
            } catch (error) {
                console.error(`Error loading catalog for brand ${brand}:`, error);
            }
        } else {
            // Get books from all brands
            const brandDirs = await fs.readdir(brandsPath);
            
            for (const brandDir of brandDirs) {
                const brandPath = path.join(brandsPath, brandDir);
                const stat = await fs.stat(brandPath);
                
                if (stat.isDirectory()) {
                    const catalogPath = path.join(brandPath, 'catalog.json');
                    try {
                        const catalogContent = await fs.readFile(catalogPath, 'utf8');
                        const catalog = JSON.parse(catalogContent);
                        if (catalog.books) {
                            // Add brand info to each book
                            const brandedBooks = catalog.books.map(book => ({
                                ...book,
                                brand: brandDir,
                                brandName: catalog.name || brandDir
                            }));
                            allBooks = allBooks.concat(brandedBooks);
                        }
                    } catch (error) {
                        // Skip brands with invalid catalogs
                    }
                }
            }
        }

        // Apply pagination if requested
        let result = allBooks;
        if (limit) {
            const start = parseInt(offset) || 0;
            const end = start + parseInt(limit);
            result = allBooks.slice(start, end);
        }

        res.json({
            success: true,
            data: result,
            total: allBooks.length,
            limit: limit ? parseInt(limit) : null,
            offset: offset ? parseInt(offset) : 0
        });
    } catch (error) {
        console.error('Error fetching books:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch books',
            message: safeMessage(error)
        });
    }
});

// Search across all brands
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ 
                success: false,
                error: 'Search query is required' 
            });
        }

        const searchTerm = q.toLowerCase();
        const brandsPath = path.join(__dirname, '..', 'frontend', 'brands');
        const brandDirs = await fs.readdir(brandsPath);
        let searchResults = [];

        for (const brandDir of brandDirs) {
            const brandPath = path.join(brandsPath, brandDir);
            const stat = await fs.stat(brandPath);
            
            if (stat.isDirectory()) {
                const catalogPath = path.join(brandPath, 'catalog.json');
                try {
                    const catalogContent = await fs.readFile(catalogPath, 'utf8');
                    const catalog = JSON.parse(catalogContent);
                    
                    if (catalog.books) {
                        const matches = catalog.books.filter(book => {
                            return (
                                book.title?.toLowerCase().includes(searchTerm) ||
                                book.author?.toLowerCase().includes(searchTerm) ||
                                book.description?.toLowerCase().includes(searchTerm) ||
                                book.tags?.some(tag => tag.toLowerCase().includes(searchTerm))
                            );
                        });

                        if (matches.length > 0) {
                            const brandedMatches = matches.map(book => ({
                                ...book,
                                brand: brandDir,
                                brandName: catalog.name || brandDir
                            }));
                            searchResults = searchResults.concat(brandedMatches);
                        }
                    }
                } catch (error) {
                    // Skip brands with invalid catalogs
                }
            }
        }

        res.json({
            success: true,
            query: q,
            results: searchResults,
            count: searchResults.length
        });
    } catch (error) {
        console.error('Error searching books:', error);
        res.status(500).json({ 
            success: false,
            error: 'Search failed',
            message: safeMessage(error)
        });
    }
});

// Get specific brand catalog
app.get('/api/brands/:brandId/catalog', async (req, res) => {
    try {
        // Sanitize brandId to prevent path traversal (CWE-22)
        const brandsBase = path.resolve(__dirname, '..', 'frontend', 'brands');
        const safe = path.basename(req.params.brandId || '');
        if (!safe || safe === '.' || safe === '..') {
            return res.status(400).json({ success: false, error: 'Invalid brand ID' });
        }
        const resolved = path.resolve(brandsBase, safe);
        if (!resolved.startsWith(brandsBase + path.sep) && resolved !== brandsBase) {
            return res.status(400).json({ success: false, error: 'Invalid brand ID' });
        }
        const catalogPath = path.join(brandsBase, safe, 'catalog.json');

        const catalogContent = await fs.readFile(catalogPath, 'utf8');
        const catalog = JSON.parse(catalogContent);

        res.json({
            success: true,
            brand: safe,
            catalog: catalog
        });
    } catch (error) {
        console.error(`Error fetching catalog for brand ${req.params.brandId}:`, error);
        res.status(404).json({
            success: false,
            error: 'Brand catalog not found',
            message: safeMessage(error)
        });
    }
});

// SSRF guard: reject private/loopback IPs and non-http(s) schemes (CWE-918)
function isAllowedPeerEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        const h = url.hostname;
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
        if (h === 'metadata.google.internal') return false;
        return true;
    } catch {
        return false;
    }
}

// Helper: fan out search to configured federation peers (3s timeout per peer)
async function searchPeers(query) {
    if (!networkConfig.networkEnabled || !networkConfig.networkPeers.length) {
        return [];
    }

    const nodeId = process.env.STORE_ID || 'openbazaar-main';
    const allowedPeers = networkConfig.networkPeers.filter(peer => {
        if (isAllowedPeerEndpoint(peer.endpoint)) return true;
        console.warn(`[Federation] Skipping peer ${peer.id} — endpoint blocked by SSRF guard: ${peer.endpoint}`);
        return false;
    });
    const peerRequests = allowedPeers.map(peer =>
        axios.get(`${peer.endpoint}/api/search`, {
            params: { q: query },
            timeout: 3000,
            headers: { 'X-Node-Id': nodeId }
        }).then(r => ({
            peer,
            results: (r.data.results || []).map(book => ({
                ...book,
                source_node: peer.endpoint,
                source_node_id: peer.id,
                revenue_share_pct: peer.revenueShare || networkConfig.referralPercentage || 10
            }))
        })).catch(err => {
            console.warn(`[Federation] Peer ${peer.id} (${peer.endpoint}) unreachable: ${err.message}`);
            return { peer, results: [] };
        })
    );

    const settled = await Promise.all(peerRequests);
    return settled.flatMap(s => s.results);
}

// Network API endpoints
app.get('/api/network/search', async (req, res) => {
    try {
        const { q } = req.query;
        const [localResults, peerResults] = await Promise.all([
            searchBooks(q),
            searchPeers(q)
        ]);

        const allResults = [...localResults, ...peerResults];
        const nodeId = process.env.STORE_ID || 'openbazaar-main';

        res.json({
            success: true,
            query: q,
            results: allResults,
            stores: [
                { id: nodeId, name: 'OpenBazaar AI', resultCount: localResults.length },
                ...networkConfig.networkPeers
                    .filter(p => peerResults.some(r => r.source_node_id === p.id))
                    .map(p => ({
                        id: p.id,
                        endpoint: p.endpoint,
                        resultCount: peerResults.filter(r => r.source_node_id === p.id).length
                    }))
            ]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Network search failed',
            message: safeMessage(error)
        });
    }
});

// Helper function for searching books
async function searchBooks(query) {
    if (!query) return [];
    
    const searchTerm = query.toLowerCase();
    const brandsPath = path.join(__dirname, '..', 'frontend', 'brands');
    const brandDirs = await fs.readdir(brandsPath);
    let results = [];

    for (const brandDir of brandDirs) {
        const catalogPath = path.join(brandsPath, brandDir, 'catalog.json');
        try {
            const catalogContent = await fs.readFile(catalogPath, 'utf8');
            const catalog = JSON.parse(catalogContent);
            
            if (catalog.books) {
                const matches = catalog.books.filter(book => {
                    return (
                        book.title?.toLowerCase().includes(searchTerm) ||
                        book.author?.toLowerCase().includes(searchTerm) ||
                        book.description?.toLowerCase().includes(searchTerm)
                    );
                });
                results = results.concat(matches.map(book => ({
                    ...book,
                    brand: brandDir
                })));
            }
        } catch (error) {
            // Skip invalid catalogs
        }
    }
    
    return results;
}

// Error handling for undefined routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ 
        error: 'API endpoint not found',
        path: req.originalUrl
    });
});

// Helper: serve an HTML file with the per-request CSP nonce injected into
// all inline <script> and <style> blocks. CWE-693.
const _frontendDir = path.resolve(path.join(__dirname, '..', 'frontend'));
async function sendNoncedHTML(res, filePath) {
    try {
        const html = await fs.readFile(filePath, 'utf8');
        const nonce = res.locals.cspNonce || '';
        // Inject nonce only on inline scripts (no src= attribute)
        let injected = html.replace(
            /<script(?!\s[^>]*\bsrc\s*=)([^>]*)>/g,
            (_, attrs) => `<script${attrs} nonce="${nonce}">`
        );
        // Inject nonce into inline <style> blocks (styleSrc nonce, CWE-693)
        injected = injected.replace(
            /<style([^>]*)>/g,
            (_, attrs) => `<style${attrs} nonce="${nonce}">`
        );
        res.type('html').send(injected);
    } catch (err) {
        console.error('[CSP] Error reading HTML for nonce injection:', err.message);
        res.status(500).send('Internal server error');
    }
}

// Intercept direct .html URL requests so inline scripts get nonces
// (covers express.static paths like /store.html, /login.html, etc.)
app.use((req, res, next) => {
    if (!req.path.endsWith('.html')) return next();
    const filePath = path.resolve(path.join(_frontendDir, req.path));
    if (!filePath.startsWith(_frontendDir + path.sep)) return next();
    sendNoncedHTML(res, filePath).catch(() => next());
});

// Serve static files in development
if (process.env.NODE_ENV !== 'production') {
    // Serve frontend files (non-HTML; HTML is handled by nonce middleware above)
    app.use(express.static(path.join(__dirname, '..', 'frontend')));

    // Serve funnel builder module
    app.use('/funnel-builder', express.static(path.join(__dirname, '..', '..', 'funnel-module', 'frontend')));

    // Serve course module
    app.use('/courses', express.static(path.join(__dirname, '..', '..', 'course-module', 'frontend')));

    // Specific routes for admin and setup
    app.get('/setup', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'setup.html'));
    });

    app.get('/admin', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'admin.html'));
    });

    app.get('/published', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'published.html'));
    });

    app.get('/published/profile/:userId', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'publisher-profile.html'));
    });

    app.get('/rewards', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'rewards.html'));
    });
}

// Static file serving - MUST BE LAST
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '..', 'frontend')));
    app.get('*', (req, res) => {
        sendNoncedHTML(res, path.join(__dirname, '..', 'frontend', 'index.html'));
    });
}

// Only start the server when this file is run directly (not when imported by tests)
if (require.main === module) {
    // Initialize database on startup
    const initDatabase = async () => {
        try {
            await require('./database/init');
            console.log('📊 Database initialized');
        } catch (error) {
            console.error('Failed to initialize database:', error);
        }
    };

    // Initialize cron jobs
    const CronJobService = require('./services/cronJobs');
    const cronService = new CronJobService();

    const PORT = process.env.PORT || 3001;
    app.listen(PORT, async () => {
        await initDatabase();
        cronService.start();
        console.log(`✅ OpenBazaar AI API running on port ${PORT}`);
        console.log(`🌍 API available at http://localhost:${PORT}/api`);
        console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`📈 Published books dashboard: http://localhost:${PORT}/published`);
    });
}

module.exports = app;
