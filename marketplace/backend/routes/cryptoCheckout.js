const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { isValidEmail } = require('../utils/validate');
const { dbRun, dbGet } = require('../services/databaseHelper');
const OrderService = require('../services/orderService');
const orderService = new OrderService();
const btcpayService = require('../services/btcpayService');
const emailService = require('../services/emailService');
const downloadService = require('../services/downloadService');
const { lookupBookPrice } = require('../services/checkoutOfferService');
const teneoListingService = require('../services/teneoListingService');
const teneoProductionClient = require('../services/teneoProductionClient');

// Rate limiter for crypto payment verification (3 attempts per 15 min per IP)
const cryptoVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: { success: false, error: 'Too many verification attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Generate unique order ID
function generateOrderId() {
    return 'ORD-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
}

// ─── Real-time Crypto Pricing ─────────────────────────────────────────────────

// CoinGecko coin IDs for each payment method
const COIN_IDS = {
    bitcoin: 'bitcoin',
    lightning: 'bitcoin', // Lightning uses BTC
    monero: 'monero'
};

// Price cache: { coinId: { usdPrice, fetchedAt } }
const priceCache = new Map();
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PRICE_LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes — price locked per order

/**
 * Fetch real-time USD price for a coin from CoinGecko (free tier, no key needed).
 * Falls back to hardcoded approximate values if the API is unavailable.
 */
async function getUsdPrice(coinId) {
    const cached = priceCache.get(coinId);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
        return cached.usdPrice;
    }

    try {
        const resp = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
            { timeout: 5000 }
        );
        const usdPrice = resp.data[coinId] && resp.data[coinId].usd;
        if (!usdPrice) throw new Error('No price data returned');

        priceCache.set(coinId, { usdPrice, fetchedAt: Date.now() });
        return usdPrice;
    } catch (error) {
        console.warn(`⚠️  CoinGecko price fetch failed for ${coinId}: ${error.message}`);
        throw new Error('Price oracle temporarily unavailable. Please try again in a moment.');
    }
}

/**
 * Convert USD amount to crypto amount using real-time rates.
 */
async function getCryptoAmount(method, usdAmount) {
    const coinId = COIN_IDS[method] || 'bitcoin';
    const usdPerCoin = await getUsdPrice(coinId);
    return (usdAmount / usdPerCoin).toFixed(8);
}

// Get payment address helper — throws if the required env var is not set
function getPaymentAddress(method) {
    const addresses = {
        bitcoin: process.env.BTC_ADDRESS,
        lightning: process.env.LIGHTNING_ADDRESS,
        monero: process.env.XMR_ADDRESS
    };
    const addr = addresses[method] || addresses.bitcoin;
    if (!addr) {
        const envVar = method === 'monero' ? 'XMR_ADDRESS' : 'BTC_ADDRESS';
        throw new Error(`Payment address for ${method} not configured. Set ${envVar} env var.`);
    }
    return addr;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Create pending crypto order
router.post('/create-order', async (req, res) => {
    try {
        let { bookId, bookTitle, bookAuthor, email, paymentMethod, brandId, format } = req.body;

        if (!bookId || !paymentMethod) {
            return res.status(400).json({ success: false, error: 'Missing required fields: bookId and paymentMethod' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Valid email address required' });
        }

        // Server-side price enforcement — never trust client-supplied price
        let teneoListing = await teneoListingService.getListingById(bookId);
        if (teneoListing) {
            bookTitle = bookTitle || teneoListing.title;
            bookAuthor = bookAuthor || teneoListing.author || 'Teneo Author';
        }

        let usdAmount = lookupBookPrice(bookId, format || 'ebook', brandId);
        if (usdAmount == null && teneoListing) {
            const requestedFormat = (teneoListing.formats || []).find((item) => item.type === (format || 'ebook'));
            usdAmount = Number(requestedFormat?.priceUSD || teneoListing.formats?.[0]?.priceUSD || 9.99);
        }
        if (usdAmount == null) {
            return res.status(400).json({ success: false, error: 'Product not found' });
        }
        const orderId = generateOrderId();
        const paymentAddress = getPaymentAddress(paymentMethod);
        const cryptoAmount = await getCryptoAmount(paymentMethod, usdAmount);

        const priceLockedAt = new Date();
        const priceExpiresAt = new Date(priceLockedAt.getTime() + PRICE_LOCK_TTL_MS);

        // ── Try BTCPay automated checkout first ──────────────────────────────
        // If BTCPay is configured, create a hosted invoice and return its URL.
        // Otherwise fall through to the existing manual wallet-address flow.
        let btcpayInvoice = null;
        try {
            btcpayInvoice = await btcpayService.createInvoice(usdAmount, orderId, email);
        } catch (btcErr) {
            console.warn('⚠️  BTCPay invoice creation failed, falling back to manual flow:', btcErr.message);
        }

        const metadata = {
            paymentMethod,
            cryptoAmount,
            walletAddress: paymentAddress,
            brandId: brandId || 'default',
            priceLockedAt: priceLockedAt.toISOString(),
            priceExpiresAt: priceExpiresAt.toISOString(),
            teneoListingId: teneoListing?.listingId || null,
            teneoBookId: teneoListing?.bookId || null,
            teneoAuthorUserId: teneoListing?.authorUserId || null,
            ...(btcpayInvoice && { btcpayInvoiceId: btcpayInvoice.invoiceId }),
        };

        // Save order to database
        await dbRun(
            `INSERT INTO orders
             (order_id, customer_email, book_id, book_title, book_author, format, price, currency, status, payment_status, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending_payment', ?)`,
            [
                orderId,
                email.toLowerCase(),
                bookId,
                bookTitle || bookId,
                bookAuthor || 'Unknown Author',
                'digital',
                usdAmount,
                'USD',
                JSON.stringify(metadata),
            ]
        );

        // ── BTCPay path: redirect customer to hosted invoice ─────────────────
        if (btcpayInvoice) {
            return res.json({
                success: true,
                orderId,
                paymentMethod: 'btcpay',
                btcpayCheckoutUrl: btcpayInvoice.checkoutUrl,
                btcpayInvoiceId: btcpayInvoice.invoiceId,
                amountUsd: usdAmount,
                priceLockedAt: priceLockedAt.toISOString(),
                priceExpiresAt: priceExpiresAt.toISOString(),
                book: { id: bookId, title: bookTitle || bookId },
                statusUrl: `/api/crypto/order-status/${orderId}`,
            });
        }

        // ── Manual fallback: show wallet address + instructions ───────────────
        // Build BIP21 URI for unified QR code (bitcoin: URI scheme, BIP-0021)
        // Wallets that support Lightning will pick up the ?lightning= param automatically.
        let bip21Uri = null;
        if (paymentMethod === 'bitcoin' || paymentMethod === 'lightning') {
            const btcAddress = process.env.BTC_ADDRESS || '';
            const lightningAddress = process.env.LIGHTNING_ADDRESS || '';
            if (btcAddress) {
                const label = encodeURIComponent(`Order #${orderId}`);
                bip21Uri = `bitcoin:${btcAddress}?amount=${cryptoAmount}&label=${label}`;
                // If a Lightning address (LNURL or bolt12) is configured, include it
                if (lightningAddress) {
                    bip21Uri += `&lightning=${encodeURIComponent(lightningAddress)}`;
                }
            }
        }

        res.json({
            success: true,
            orderId,
            paymentMethod,
            address: paymentAddress,
            amount: cryptoAmount,
            amountUsd: usdAmount,
            bip21Uri,
            priceLockedAt: priceLockedAt.toISOString(),
            priceExpiresAt: priceExpiresAt.toISOString(),
            book: { id: bookId, title: bookTitle || bookId },
            instructions: {
                step1: `Send ${cryptoAmount} ${paymentMethod.toUpperCase()} to: ${paymentAddress}`,
                step2: `Include order ID in memo/notes: ${orderId}`,
                step3: `Email payment proof to orders@teneo.market with subject: Order ${orderId}`,
                step4: 'Your download link will be sent within 1–24 hours after verification'
            },
            statusUrl: `/api/crypto/order-status/${orderId}`
        });

    } catch (error) {
        console.error('Crypto order creation error:', error);
        if (error.message && error.message.includes('Price oracle')) {
            return res.status(503).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, error: 'Failed to create order' });
    }
});

// Get order status by order ID
router.get('/order-status/:orderId', async (req, res) => {
    try {
        const order = await dbGet(
            'SELECT order_id, book_title, price, status, payment_status, created_at FROM orders WHERE order_id = ?',
            [req.params.orderId]
        );
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

        res.json({
            success: true,
            orderId: order.order_id,
            bookTitle: order.book_title,
            amountUsd: order.price,
            status: order.status,
            paymentStatus: order.payment_status,
            createdAt: order.created_at
        });
    } catch (error) {
        console.error('Order status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order status' });
    }
});

// Get current exchange rates (for frontend display)
router.get('/rates', async (req, res) => {
    try {
        const [btcPrice, xmrPrice] = await Promise.all([
            getUsdPrice('bitcoin'),
            getUsdPrice('monero')
        ]);
        res.json({
            success: true,
            rates: {
                bitcoin: btcPrice,
                lightning: btcPrice,
                monero: xmrPrice
            },
            currency: 'USD',
            cachedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Rates error:', error);
        res.status(503).json({ success: false, error: 'Price oracle temporarily unavailable. Please try again in a moment.' });
    }
});

// Verify payment (manual for MVP; automated with BTCPay in future)
router.post('/verify-payment', cryptoVerifyLimiter, async (req, res) => {
    try {
        const { orderId, transactionId, email } = req.body;
        if (!orderId) return res.status(400).json({ success: false, error: 'orderId required' });

        // Verify the email matches the order owner to prevent unauthorized tampering
        const order = await dbGet('SELECT order_id, customer_email, metadata FROM orders WHERE order_id = ?', [orderId]);
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

        if (!email || order.customer_email.toLowerCase() !== email.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Verification failed' });
        }

        // Enforce price lock expiry — customer must restart checkout if price has expired
        try {
            const meta = JSON.parse(order.metadata || '{}');
            if (meta.priceExpiresAt && Date.now() > new Date(meta.priceExpiresAt).getTime()) {
                return res.status(410).json({
                    success: false,
                    expired: true,
                    error: 'Price has expired — please refresh your order and try again',
                });
            }
        } catch (_) {
            // If metadata is unparseable, allow the verification to proceed
        }

        // Update order with transaction ID for admin review
        await dbRun(
            `UPDATE orders SET metadata = json_set(COALESCE(metadata, '{}'), '$.transactionId', ?), updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
            [transactionId || '', orderId]
        );

        res.json({
            success: true,
            message: 'Payment verification submitted. Your download link will be sent within 24 hours after we confirm the transaction.',
            orderId
        });
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ success: false, error: 'Failed to verify payment' });
    }
});

// ─── BTCPay Webhook ───────────────────────────────────────────────────────────

/**
 * POST /api/crypto/btcpay/webhook
 *
 * Receives payment event notifications from BTCPay Server.
 * On InvoiceSettled (fully paid): mark order completed, send download link.
 *
 * Note: this route must be excluded from CSRF middleware (webhook caller has no
 * session cookie). Server.js already excludes /api/crypto/btcpay/webhook.
 */
router.post('/btcpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['btcpay-sig1'] || '';

    // Validate HMAC signature
    if (!btcpayService.verifyWebhookSignature(req.body, signature)) {
        console.warn('BTCPay webhook: invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
        event = JSON.parse(req.body.toString());
    } catch (parseErr) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // We only care about settled invoices
    if (event.type !== 'InvoiceSettled') {
        return res.json({ received: true });
    }

    try {
        const invoiceId = event.invoiceId || (event.invoice && event.invoice.id);
        if (!invoiceId) return res.json({ received: true });

        // Find order by btcpayInvoiceId in metadata
        const order = await dbGet(
            `SELECT order_id, customer_email, book_id, book_title, book_author, price, metadata FROM orders
             WHERE json_extract(metadata, '$.btcpayInvoiceId') = ?`,
            [invoiceId]
        );

        if (!order) {
            console.warn(`BTCPay webhook: no order found for invoiceId ${invoiceId}`);
            return res.json({ received: true });
        }

        // Mark order as completed
        await dbRun(
            `UPDATE orders SET status = 'completed', payment_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
            [order.order_id]
        );

        // Generate download token directly — no HTTP self-call
        try {
            const metadata = JSON.parse(order.metadata || '{}');
            let downloadUrl = null;
            if (metadata.teneoListingId) {
                const paidResult = await teneoProductionClient.orderPaid({
                    orderId: order.order_id,
                    listingId: metadata.teneoListingId,
                    buyerEmail: order.customer_email,
                    buyerUserId: null,
                    paymentMethod: 'btcpay',
                    amountUSD: order.price,
                    paidAt: new Date().toISOString(),
                });
                downloadUrl = paidResult?.downloadUrl || null;
                await teneoListingService.recordPurchase(metadata.teneoListingId, order.price);
            }
            if (!downloadUrl) {
                const generated = await downloadService.generateDownloadToken({ orderId: order.order_id });
                downloadUrl = generated.downloadUrl;
            }
            await emailService.sendDownloadEmail({
                userEmail: order.customer_email,
                bookTitle: order.book_title,
                bookAuthor: order.book_author || 'Unknown Author',
                downloadUrl,
                orderId: order.order_id,
                expiresIn: '24 hours',
                maxDownloads: 5,
            });
            console.log(`✅ BTCPay: order ${order.order_id} fulfilled, download sent to ${order.customer_email}`);
        } catch (fulfillErr) {
            console.error('BTCPay webhook: fulfillment error', {
                orderId: order.order_id,
                customerEmail: order.customer_email,
                error: fulfillErr.message,
                stack: fulfillErr.stack
            });
            await orderService.failOrder(order.order_id, fulfillErr.message)
                .catch(err => console.error('[btcpay-webhook] Failed to mark order failed:', order.order_id, err));
        }
    } catch (err) {
        console.error('BTCPay webhook processing error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }

    res.json({ received: true });
});

module.exports = router;
