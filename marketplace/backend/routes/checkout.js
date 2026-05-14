const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { safeMessage, sanitizeMetadataValue, isValidEmail } = require('../utils/validate');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const btcpayService = require('../services/btcpayService');
const arxmintService = require('../services/arxmintService');
const stripeHealthService = require('../services/stripeHealthService');
const {
  sanitizeBrandId,
  lookupBookPrice,
  applyCouponToPrice,
  getNextReadOffer,
  resolveCatalogItem
} = require('../services/checkoutOfferService');
const couponService = require('../services/couponService');
const orderBumpService = require('../services/orderBumpService');
const OrderService = require('../services/orderService');
const orderService = new OrderService();
const emailService = require('../services/emailService');
const { processMixedOrder } = require('./checkoutMixed');
const nftService = require('../services/nftService');
const shippingService = require('../services/shippingService');
const db = require('../database/database');
const { enrollUserInCourse } = require('./courseRoutes');
const licenseKeyService = require('../services/licenseKeyService');
const { trackReferral } = require('./referralRoutes');
const teneoListingService = require('../services/teneoListingService');
const teneoProductionClient = require('../services/teneoProductionClient');

const isProduction = process.env.NODE_ENV === 'production';

// Rate limiter configuration constants
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CHECKOUT_RATE_LIMIT_MAX = 10;
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const WEBHOOK_RATE_LIMIT_MAX = 30;

// Allowlist of valid product format values (CWE-20: input validation)
const ALLOWED_FORMATS = ['pdf', 'epub', 'print', 'ebook', 'digital', 'bundle', 'hardcover'];

// Checkout session rate limiter — 10 per hour per IP (CWE-770)
// Disabled in test environment to allow test suites to run freely
const checkoutLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: CHECKOUT_RATE_LIMIT_WINDOW_MS,
      max: CHECKOUT_RATE_LIMIT_MAX,
      message: { success: false, error: 'Too many checkout attempts. Please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    });

router.post('/create-session', checkoutLimiter, async (req, res) => {
  try {
    // Do not destructure 'price' from req.body — client-supplied price is untrusted
    let {
      bookId,
      format,
      brandId: rawBrandId,
      bookTitle,
      bookAuthor,
      userEmail,
      couponCode,
      bumpAccepted,
      bumpId,
      referralCode: rawReferralCode
    } = req.body;
    const brandId = sanitizeBrandId(rawBrandId);
    const referralCode = rawReferralCode
      ? sanitizeMetadataValue(String(rawReferralCode).toUpperCase(), 20)
      : (req.session?.referralCode || null);
    const funnelId = sanitizeMetadataValue(req.body.funnelId, 80);
    const funnelSessionId = sanitizeMetadataValue(req.body.funnelSessionId, 120);
    const courseSlug = sanitizeMetadataValue(req.body.courseSlug, 120);

    let teneoListing = null;
    if (bookId) {
      teneoListing = await teneoListingService.getListingById(bookId);
      if (teneoListing) {
        bookTitle = bookTitle || teneoListing.title;
        bookAuthor = bookAuthor || teneoListing.author || 'Teneo Author';
      }
    }

    if (!bookId || !format || !bookTitle || !bookAuthor || !userEmail) {
      return res.status(400).json({
        error: 'Missing required fields: bookId, format, bookTitle, bookAuthor, userEmail'
      });
    }

    if (!ALLOWED_FORMATS.includes(format)) {
      return res.status(400).json({ success: false, error: `Invalid format. Allowed values: ${ALLOWED_FORMATS.join(', ')}` });
    }

    // Check Stripe availability before attempting session creation.
    // If Stripe is down, return a fallback signal so the frontend can redirect
    // to the crypto checkout flow instead of showing a generic error.
    const stripeHealth = await stripeHealthService.checkStripeHealth();
    if (!stripeHealth.healthy) {
      return res.status(503).json({
        success: false,
        stripeDown: true,
        fallbackUrl: '/checkout/crypto',
        message: 'Stripe payment temporarily unavailable — please use crypto checkout',
      });
    }

    // Look up authoritative price from catalog — never use the client-supplied price
    let catalogPrice = lookupBookPrice(bookId, format, brandId);
    if (catalogPrice == null && teneoListing) {
      const requestedFormat = (teneoListing.formats || []).find((item) => item.type === format);
      catalogPrice = Number(requestedFormat?.priceUSD || teneoListing.formats?.[0]?.priceUSD || 9.99);
    }
    if (catalogPrice == null) {
      return res.status(400).json({ success: false, error: 'Book not found in catalog' });
    }

    // Validate coupon server-side via couponService (DB + static fallback)
    let pricing;
    if (couponCode) {
      const couponResult = await couponService.validateCoupon(couponCode, catalogPrice);
      if (couponResult.valid) {
        const discountAmount = Math.round(couponResult.discountAmount * 100) / 100;
        const finalPrice = Math.max(0.5, Math.round((catalogPrice - discountAmount) * 100) / 100);
        pricing = {
          basePrice: catalogPrice,
          finalPrice,
          discountAmount,
          couponCode: couponResult.code,
          applied: discountAmount > 0,
        };
      } else {
        pricing = { basePrice: catalogPrice, finalPrice: catalogPrice, discountAmount: 0, couponCode: null, applied: false };
      }
    } else {
      pricing = applyCouponToPrice(catalogPrice, null);
    }
    const unitPrice = pricing.finalPrice;
    const orderId = `order_${Date.now()}_${bookId}`;
    const nextReadOffer = getNextReadOffer(bookId, brandId);

    // Validate order bump server-side — never trust client-supplied bump price
    let bumpLineItem = null;
    if (bumpAccepted) {
      const bump = bumpId
        ? await orderBumpService.getBumpById(bumpId)
        : await orderBumpService.getBumpForProduct(bookId);
      if (bump) {
        bumpLineItem = {
          price_data: {
            currency: 'usd',
            product_data: { name: bump.bump_product_name, description: bump.bump_description || undefined },
            unit_amount: Math.round(bump.bump_price * 100),
          },
          quantity: 1,
        };
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: userEmail,
      client_reference_id: orderId,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${bookTitle} - ${format}`,
              description: `by ${bookAuthor} - Format: ${format}`,
              metadata: {
                bookId: bookId,
                format: format,
                bookTitle: bookTitle,
                bookAuthor: bookAuthor
              }
            },
            unit_amount: Math.round(unitPrice * 100),
          },
          quantity: 1,
        },
        ...(bumpLineItem ? [bumpLineItem] : []),
      ],
      mode: 'payment',
      success_url: `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/cancel.html`,
      metadata: {
        bookId: bookId,
        format: format,
        bookTitle: bookTitle,
        bookAuthor: bookAuthor,
        userEmail: userEmail,
        orderId: orderId,
        fulfillmentStatus: 'pending',
        brandId: brandId || '',
        couponCode: pricing.couponCode || '',
        couponDiscount: pricing.discountAmount ? String(pricing.discountAmount) : '',
        funnelId: funnelId || '',
        funnelSessionId: funnelSessionId || '',
        courseSlug: courseSlug || '',
        product_type: courseSlug ? 'course' : '',
        referralCode: referralCode || '',
        teneoListingId: teneoListing?.listingId || '',
        teneoBookId: teneoListing?.bookId || '',
        teneoAuthorUserId: teneoListing?.authorUserId || ''
      },
      // Save payment method for post-purchase one-click upsells
      payment_intent_data: {
        description: `Order ${orderId}: ${bookTitle}`,
        setup_future_usage: 'off_session',
        ...(isProduction && {
          statement_descriptor: 'TENEO BOOKS',
          statement_descriptor_suffix: bookId.substring(0, 10).toUpperCase(),
        }),
        metadata: {
          orderId,
          bookId,
          teneoListingId: teneoListing?.listingId || '',
          teneoBookId: teneoListing?.bookId || '',
          teneoAuthorUserId: teneoListing?.authorUserId || ''
        }
      },
      billing_address_collection: isProduction ? 'required' : 'auto'
    });

    // Create order record in database at session creation time
    await orderService.createOrder({
      orderId,
      stripeSessionId: session.id,
      customerEmail: userEmail,
      bookId,
      bookTitle,
      bookAuthor,
      format,
      price: catalogPrice,
      currency: 'USD',
      metadata: {
        sessionUrl: session.url,
        createdAt: new Date().toISOString(),
        couponCode: pricing.couponCode || null,
        discountAmount: pricing.discountAmount || 0,
        brandId: brandId || null,
        nextReadOffer,
        teneoListingId: teneoListing?.listingId || null,
        teneoBookId: teneoListing?.bookId || null,
        teneoAuthorUserId: teneoListing?.authorUserId || null
      }
    });

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id,
      orderId: orderId,
      pricing: {
        basePrice: pricing.basePrice,
        finalPrice: pricing.finalPrice,
        discountAmount: pricing.discountAmount,
        couponCode: pricing.couponCode
      },
      nextReadOffer
    });
  } catch (error) {
    console.error('Stripe session creation error:', error);
    if (error.type === 'StripeCardError') {
      res.status(400).json({ error: 'Card error', message: safeMessage(error) });
    } else if (error.type === 'StripeInvalidRequestError') {
      res.status(400).json({ error: 'Invalid request', message: safeMessage(error) });
    } else {
      res.status(500).json({
        error: 'Failed to create checkout session',
        message: safeMessage(error)
      });
    }
  }
});

// Retrieve Stripe session details for success page analytics
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items']
    });

    res.json({
      success: true,
      orderId: session.metadata?.orderId || sessionId,
      bookId: session.metadata?.bookId || '',
      bookTitle: session.metadata?.bookTitle || 'Book purchase',
      bookAuthor: session.metadata?.bookAuthor || '',
      brandId: session.metadata?.brandId || '',
      format: session.metadata?.format || '',
      amount: session.amount_total || 0,
      currency: session.currency || 'usd',
      customerEmail: session.customer_email || session.customer_details?.email || '',
      funnelId: session.metadata?.funnelId || '',
      funnelSessionId: session.metadata?.funnelSessionId || '',
      nextReadOffer: getNextReadOffer(
        session.metadata?.bookId,
        sanitizeBrandId(session.metadata?.brandId)
      ),
      items: (session.line_items?.data || []).map(item => ({
        name: item.description || item.price?.product_data?.name || 'Book',
        quantity: item.quantity,
        amount: item.amount_total
      }))
    });
  } catch (error) {
    console.error('Error retrieving Stripe session:', error);
    res.status(500).json({ error: 'Failed to retrieve session', message: safeMessage(error) });
  }
});

// Stripe webhook handler
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('Webhook secret not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency — skip if already processed
  const alreadyProcessed = await orderService.isEventProcessed(event.id);
  if (alreadyProcessed) {
    console.log(`Event ${event.id} already processed, skipping`);
    return res.json({ received: true, skipped: true });
  }

  // Log the incoming event
  await orderService.logPaymentEvent({
    stripeEventId: event.id,
    eventType: event.type,
    orderId: event.data.object.metadata?.orderId,
    payload: event.data.object
  });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'checkout.session.expired':
        await handleCheckoutExpired(event.data.object);
        break;

      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object);
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    await orderService.markEventProcessed(event.id, true);
  } catch (error) {
    console.error(`Error processing webhook ${event.type}:`, error);
    await orderService.markEventProcessed(event.id, false, error.message);
    // Return 200 to prevent Stripe from retrying
    return res.json({ received: true, error: safeMessage(error) });
  }

  res.json({ received: true });
});

async function handleCheckoutCompleted(session) {
  console.log('Processing successful checkout:', session.id);

  // Route store builder payments — update build status to 'paid'
  if (session.metadata && session.metadata.storeBuilderBuildId) {
    const storeBuildService = require('../services/storeBuildService');
    const buildId = session.metadata.storeBuilderBuildId;
    try {
      await storeBuildService.updateStatus(buildId, 'paid', `Stripe session ${session.id}`);
      console.log(`[StoreBuilder] Build ${buildId} marked as paid via Stripe session ${session.id}`);
    } catch (err) {
      console.error(`[StoreBuilder] Failed to mark build ${buildId} as paid:`, err.message);
    }
    return;
  }

  // Route mixed orders (digital + physical) to the dedicated mixed fulfillment handler
  if (session.metadata && session.metadata.orderType === 'mixed') {
    console.log('Mixed order detected, routing to processMixedOrder');
    return await processMixedOrder(session);
  }

  // Route store product orders — complete order + confirm email, skip book-specific download flow
  if (session.metadata && session.metadata.productType === 'store_product') {
    const { orderId: storeOrderId, userEmail: storeEmail } = session.metadata;
    try {
      await orderService.completeOrder(storeOrderId, session.payment_intent);
      await emailService.sendOrderConfirmation({
        userEmail: storeEmail,
        bookTitle: session.metadata.productId,
        bookAuthor: '',
        price: session.amount_total / 100,
        orderId: storeOrderId,
        paymentMethod: session.payment_method_types?.[0] || 'card',
      });
      await orderService.fulfillOrder(storeOrderId);
      await orderService.updateOrderState(storeOrderId, 'completed', {
        provider: 'stripe', paymentIntent: session.payment_intent,
      }).catch(err => console.warn('[state-machine] store-product completed failed (non-fatal):', err.message));
      console.log(`[store-product] Order ${storeOrderId} fulfilled`);
    } catch (err) {
      console.error('[store-product] Fulfillment error:', err.message);
      if (storeOrderId) {
        await orderService.failOrder(storeOrderId, err.message).catch(() => {});
      }
      throw err;
    }
    return;
  }

  const {
    bookId,
    bookTitle,
    bookAuthor,
    userEmail,
    orderId
  } = session.metadata;

  // Transition order to 'processing' when payment is confirmed (non-fatal —
  // state column may not exist on older databases that haven't re-run init.js)
  await orderService.updateOrderState(orderId, 'processing', {
    provider: 'stripe',
    sessionId: session.id,
  }).catch(err => console.warn('[state-machine] pending→processing failed (non-fatal):', err.message));

  try {
    // Record funnel purchase event if applicable
    if (session.metadata?.funnelId) {
      const purchaseMetadata = JSON.stringify({
        orderId,
        amount: session.amount_total ? session.amount_total / 100 : null,
        currency: session.currency || 'usd',
        bookId,
        bookTitle
      });
      db.run(
        `INSERT INTO funnel_events (funnel_id, page_slug, event_type, session_id, metadata)
         VALUES (?, ?, 'purchase', ?, ?)`,
        [
          session.metadata.funnelId,
          session.metadata.funnelId,
          session.metadata.funnelSessionId || null,
          purchaseMetadata
        ],
        err => {
          if (err) {
            console.warn('Failed to record funnel purchase event:', err.message);
          }
        }
      );
    }

    // Increment coupon used_count for DB-backed coupons (no-op for static coupons)
    if (session.metadata?.couponCode) {
      await couponService.applyCoupon(session.metadata.couponCode).catch(err =>
        console.warn('[checkout] applyCoupon failed (non-fatal):', err.message)
      );
    }

    // Mark order complete and get download token
    const { downloadToken } = await orderService.completeOrder(
      orderId,
      session.payment_intent
    );

    let teneoDownloadUrl = null;
    if (session.metadata?.teneoListingId) {
      const amountUSD = session.amount_total ? session.amount_total / 100 : 0;
      const paidResult = await teneoProductionClient.orderPaid({
        orderId,
        listingId: session.metadata.teneoListingId,
        buyerEmail: userEmail,
        buyerUserId: session.customer || null,
        paymentMethod: session.payment_method_types?.[0] || 'card',
        amountUSD,
        paidAt: new Date().toISOString(),
      });
      teneoDownloadUrl = paidResult?.downloadUrl || null;
      await teneoListingService.recordPurchase(session.metadata.teneoListingId, amountUSD);
    }

    // Persist Stripe customer + payment method for post-purchase one-click upsells (non-fatal)
    if (session.customer && session.payment_intent) {
      try {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
        const pmId = pi.payment_method;
        if (pmId) {
          db.run(
            `UPDATE orders SET stripe_customer_id = ?, stripe_payment_method_id = ? WHERE order_id = ?`,
            [session.customer, pmId, orderId],
            err => { if (err) console.warn('[upsell] Failed to save customer/pm:', err.message); }
          );
        }
      } catch (pmErr) {
        console.warn('[upsell] Could not retrieve payment method (non-fatal):', pmErr.message);
      }
    }

    // Send order confirmation email
    await emailService.sendOrderConfirmation({
      userEmail,
      bookTitle,
      bookAuthor,
      price: session.amount_total / 100,
      orderId,
      paymentMethod: session.payment_method_types?.[0] || 'card'
    });

    await orderService.logEmail({
      orderId,
      emailType: 'order_confirmation',
      recipientEmail: userEmail,
      subject: `Order Confirmed: "${bookTitle}"`,
      status: 'sent'
    });

    // Build download URL from token
    const downloadUrl = teneoDownloadUrl || `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/api/download/${downloadToken}`;

    // Send download email
    const emailResult = await emailService.sendDownloadEmail({
      userEmail,
      bookTitle,
      bookAuthor,
      downloadUrl,
      orderId,
      expiresIn: '24 hours',
      maxDownloads: 5
    });

    await orderService.logEmail({
      orderId,
      emailType: 'download_link',
      recipientEmail: userEmail,
      subject: `Your book "${bookTitle}" is ready for download`,
      status: emailResult.success ? 'sent' : 'failed',
      errorMessage: emailResult.error,
      messageId: emailResult.messageId
    });

    await orderService.fulfillOrder(orderId);

    // Transition to 'completed' after fulfillment (non-fatal)
    await orderService.updateOrderState(orderId, 'completed', {
      provider: 'stripe',
      paymentIntent: session.payment_intent,
    }).catch(err => console.warn('[state-machine] processing→completed failed (non-fatal):', err.message));

    console.log(`Download link sent to ${userEmail} for order ${orderId}`);

    // Generate license key if product requires it (non-fatal)
    try {
      const brandId = session.metadata?.brandId || null;
      const resolved = resolveCatalogItem(bookId, brandId);
      const item = resolved?.item;
      if (item && item.license_required) {
        const maxActivations = item.license_max_activations || 3;
        const { key } = await licenseKeyService.createLicenseKey(orderId, bookId, userEmail, maxActivations);
        console.log(`[license] Key generated for order ${orderId}: ${key}`);
        // Send license key email
        await emailService.sendLicenseKeyEmail({ userEmail, bookTitle, orderId, licenseKey: key, maxActivations }).catch(
          err => console.warn('[license] License email failed (non-fatal):', err.message)
        );
      }
    } catch (licenseErr) {
      console.error('[license] License key generation failed (non-fatal):', licenseErr.message);
    }

    // Track referral commission if order came via a referral link (non-fatal)
    if (session.metadata?.referralCode) {
      trackReferral({
        referralCode: session.metadata.referralCode,
        orderId,
        customerEmail: userEmail,
        orderAmount: session.amount_total ? session.amount_total / 100 : 0,
      }).catch(err => console.warn('[referral] trackReferral failed (non-fatal):', err.message));
    }

    // Pin purchased book to IPFS for censorship-resistant delivery (non-fatal)
    if (process.env.PINATA_JWT && bookId) {
      const bookFilePath = path.join(__dirname, '../books', `${bookId}.pdf`);
      nftService.pinBookToIPFS(bookId, bookFilePath)
        .catch(err => console.error('[IPFS] Pin failed (non-fatal):', err.message));
    }

    // Enroll buyer in course if this is a course purchase (idempotent via INSERT OR IGNORE)
    if (session.metadata?.courseSlug || session.metadata?.product_type === 'course') {
      const slug = session.metadata.courseSlug;
      const email = userEmail || session.customer_email;
      if (slug && email) {
        try {
          await enrollUserInCourse(slug, email, orderId);
          console.log(`Course enrollment granted: ${email} → ${slug} (order ${orderId})`);
        } catch (enrollErr) {
          console.error('Course enrollment failed (non-fatal):', enrollErr.message);
        }
      }
    }

  } catch (error) {
    console.error('Fulfillment error', {
      eventType: 'checkout.session.completed',
      sessionId: session?.id,
      orderId,
      customerEmail: session?.customer_details?.email,
      error: error.message,
      stack: error.stack
    });
    if (orderId) {
      await orderService.failOrder(orderId, error.message)
        .catch(err => console.error('[checkout] Failed to mark order failed:', orderId, err));
      await orderService.updateOrderState(orderId, 'failed', {
        reason: error.message,
        provider: 'stripe',
      }).catch(err => console.error('[checkout] Failed to update order state to failed:', orderId, err));
    }
    throw error;
  }
}

async function handleCheckoutExpired(session) {
  const { orderId } = session.metadata || {};
  if (orderId) {
    await orderService.updateOrderStatus(orderId, {
      status: 'expired',
      payment_status: 'expired'
    });
  }
}

async function handlePaymentSucceeded(paymentIntent) {
  console.log('Payment succeeded:', paymentIntent.id);
  // Additional payment success handling if needed
}

async function handlePaymentFailed(paymentIntent) {
  const { orderId } = paymentIntent.metadata || {};

  if (orderId) {
    await orderService.failOrder(orderId, paymentIntent.last_payment_error?.message || 'Payment failed');

    const order = await orderService.getOrder(orderId);
    if (order && order.customer_email) {
      try {
        await emailService.sendPaymentFailureEmail({
          userEmail: order.customer_email,
          bookTitle: order.book_title,
          orderId,
          errorMessage: paymentIntent.last_payment_error?.message
        });
      } catch (error) {
        console.error('Error sending payment failure email:', error);
      }
    }
  }
}

async function handleChargeRefunded(charge) {
  console.log('Processing refund:', charge.id);

  const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
  const { orderId } = paymentIntent.metadata || {};

  if (orderId) {
    const refundId = `refund_${Date.now()}`;
    const refundAmount = charge.amount_refunded / 100;

    await orderService.refundOrder(orderId, {
      refundId,
      stripeRefundId: charge.refunds.data[0]?.id,
      amount: refundAmount,
      reason: charge.refunds.data[0]?.reason || 'requested_by_customer'
    });

    // Transition to 'refunded' state (non-fatal)
    await orderService.updateOrderState(orderId, 'refunded', {
      refundId,
      stripeRefundId: charge.refunds.data[0]?.id,
      amount: refundAmount,
    }).catch(err => console.warn('[state-machine] completed→refunded failed (non-fatal):', err.message));

    const order = await orderService.getOrder(orderId);
    let teneoListingId = paymentIntent.metadata?.teneoListingId || null;
    if (!teneoListingId && order?.metadata) {
      try {
        teneoListingId = JSON.parse(order.metadata).teneoListingId || null;
      } catch {
        teneoListingId = null;
      }
    }
    if (teneoListingId) {
      try {
        await teneoProductionClient.refund({
          orderId,
          listingId: teneoListingId,
          reason: charge.refunds.data[0]?.reason || 'requested_by_customer',
        });
        await teneoListingService.recordRefund(teneoListingId, refundAmount);
      } catch (callbackErr) {
        console.warn('[teneo-callback] marketplace.refund failed (non-fatal):', callbackErr.message);
      }
    }

    if (order && order.customer_email) {
      try {
        await emailService.sendRefundConfirmationEmail({
          userEmail: order.customer_email,
          bookTitle: order.book_title,
          orderId,
          refundAmount,
          currency: order.currency
        });
      } catch (error) {
        console.error('Error sending refund email:', error);
      }
    }
  }
}

// Get order status
router.get('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await orderService.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      success: true,
      order: {
        orderId: order.order_id,
        status: order.status,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        bookTitle: order.book_title,
        bookAuthor: order.book_author,
        price: order.price,
        createdAt: order.created_at
      }
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Process refund (admin endpoint)
router.post('/refund/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason = 'requested_by_customer', amount } = req.body;

    const order = await orderService.getOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'Order has no payment to refund' });
    }

    const refundAmount = amount || order.price;

    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      amount: Math.round(refundAmount * 100),
      reason,
      metadata: { orderId: order.order_id }
    });

    res.json({
      success: true,
      refund: {
        id: refund.id,
        amount: refund.amount / 100,
        status: refund.status,
        reason: refund.reason
      }
    });
  } catch (error) {
    console.error('Refund error:', error);
    res.status(500).json({
      error: 'Failed to process refund',
      message: safeMessage(error)
    });
  }
});

// Order bump offer endpoint — returns the active bump for a given product
router.get('/bump', async (req, res) => {
  try {
    const { productId } = req.query;
    const bump = await orderBumpService.getBumpForProduct(productId || null);
    if (!bump) {
      return res.json({ bump: null });
    }
    res.json({
      bump: {
        id: bump.id,
        name: bump.bump_product_name,
        description: bump.bump_description,
        price: bump.bump_price,
      }
    });
  } catch (error) {
    console.error('Error fetching order bump:', error);
    res.status(500).json({ error: 'Failed to fetch order bump' });
  }
});

// ─── Post-purchase upsell endpoints ─────────────────────────────────────────

/**
 * GET /api/checkout/upsell-offer?orderId=X
 * Returns the upsell offer for the product in the given order.
 */
router.get('/upsell-offer', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const order = await orderService.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const upsell = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM upsells
         WHERE active = 1
           AND (product_id = ? OR product_id IS NULL)
         ORDER BY product_id DESC LIMIT 1`,
        [order.book_id],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });

    if (!upsell) return res.json({ upsell: null });

    res.json({
      upsell: {
        id: upsell.id,
        productId: upsell.upsell_product_id,
        productName: upsell.upsell_product_name,
        headline: upsell.headline,
        description: upsell.description,
        priceCents: upsell.upsell_price_cents,
        priceUsd: (upsell.upsell_price_cents / 100).toFixed(2),
        hasOneClick: !!(order.stripe_customer_id && order.stripe_payment_method_id),
      }
    });
  } catch (error) {
    console.error('Error fetching upsell offer:', error);
    res.status(500).json({ error: 'Failed to fetch upsell offer', message: safeMessage(error) });
  }
});

/**
 * POST /api/checkout/upsell
 * Process a one-click post-purchase upsell.
 * Body: { orderId, upsellId }
 * Uses the saved payment method — no card re-entry required.
 * Falls back to new Stripe Checkout session when payment method not available.
 */
router.post('/upsell', checkoutLimiter, async (req, res) => {
  try {
    const { orderId, upsellId } = req.body;
    if (!orderId || !upsellId) {
      return res.status(400).json({ error: 'orderId and upsellId are required' });
    }

    const order = await orderService.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Original order must be completed to add an upsell' });
    }

    const upsell = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM upsells WHERE id = ? AND active = 1`,
        [Number(upsellId)],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });

    if (!upsell) return res.status(404).json({ error: 'Upsell offer not found or inactive' });

    const upsellOrderId = `upsell_${Date.now()}_${upsell.upsell_product_id}`;

    // One-click path: charge saved payment method off-session
    if (order.stripe_customer_id && order.stripe_payment_method_id) {
      const pi = await stripe.paymentIntents.create({
        amount: upsell.upsell_price_cents,
        currency: 'usd',
        customer: order.stripe_customer_id,
        payment_method: order.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: `Upsell ${upsellOrderId}: ${upsell.upsell_product_name}`,
        metadata: { orderId: upsellOrderId, originalOrderId: orderId, upsellId: String(upsell.id) }
      });

      await orderService.createOrder({
        orderId: upsellOrderId,
        customerEmail: order.customer_email,
        bookId: upsell.upsell_product_id,
        bookTitle: upsell.upsell_product_name,
        bookAuthor: '',
        format: 'upsell',
        price: upsell.upsell_price_cents / 100,
        currency: 'USD',
        metadata: { originalOrderId: orderId, upsellId: upsell.id, stripePaymentIntentId: pi.id }
      });

      return res.json({ success: true, method: 'one_click', newOrderId: upsellOrderId, status: pi.status });
    }

    // Fallback: new Stripe Checkout session (card entry required)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: order.customer_email,
      client_reference_id: upsellOrderId,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: upsell.upsell_product_name, description: upsell.description || undefined },
          unit_amount: upsell.upsell_price_cents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.PUBLIC_URL || 'http://localhost:3001'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_URL || 'http://localhost:3001'}/`,
      metadata: { orderId: upsellOrderId, originalOrderId: orderId, upsellId: String(upsell.id) }
    });

    res.json({ success: true, method: 'new_session', newOrderId: upsellOrderId, checkoutUrl: session.url });
  } catch (error) {
    console.error('Upsell processing error:', error);
    if (error.code === 'authentication_required' || error.code === 'card_declined') {
      return res.status(402).json({
        success: false,
        requiresAction: true,
        error: 'Card requires authentication. Please complete purchase in a new session.',
        message: safeMessage(error)
      });
    }
    res.status(500).json({ success: false, error: 'Failed to process upsell', message: safeMessage(error) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Stripe health status endpoint — used by status pages and monitoring
router.get('/health/stripe', async (req, res) => {
  const health = await stripeHealthService.checkStripeHealth();
  const statusCode = health.healthy ? 200 : 503;
  res.status(statusCode).json({
    healthy: health.healthy,
    lastChecked: health.lastChecked ? new Date(health.lastChecked).toISOString() : null,
    ...(health.error && { error: health.error }),
  });
});

/**
 * POST /api/checkout/arxmint
 * ArxMint Lightning checkout endpoint.
 * Tries ArxMint L402 first, then BTCPay, then manual wallet address fallback.
 * Always enforces server-side pricing — never trusts client-supplied price.
 */
router.post('/arxmint', checkoutLimiter, async (req, res) => {
  try {
    const { bookId, format: rawFormat, brandId: rawBrandId, bookTitle, bookAuthor, userEmail } = req.body;
    const format = ALLOWED_FORMATS.includes(rawFormat) ? rawFormat : 'ebook';
    const brandId = sanitizeBrandId(rawBrandId);

    if (!bookId || !userEmail) {
      return res.status(400).json({ success: false, error: 'Missing required fields: bookId, userEmail' });
    }
    if (!isValidEmail(userEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email address required' });
    }

    // Server-side price enforcement — never trust client-supplied price
    const usdAmount = lookupBookPrice(bookId, format || 'ebook', brandId);
    if (usdAmount == null) {
      return res.status(400).json({ success: false, error: 'Product not found in catalog' });
    }

    const orderId = `arxmint_${Date.now()}_${bookId}`;

    // 1. Try ArxMint L402 Lightning invoice (graceful degradation when stub)
    let invoice = null;
    let macaroon = null;
    const btcFallbackPrice = parseInt(process.env.BTC_FALLBACK_PRICE_USD || '0', 10);
    if (!btcFallbackPrice) {
      console.error('[checkout] BTC_FALLBACK_PRICE_USD not set — cannot calculate sats amount accurately');
      return res.status(503).json({ success: false, error: 'Lightning payment temporarily unavailable' });
    }
    const amountSats = Math.round((usdAmount / btcFallbackPrice) * 1e8);
    const arxmintAttempt = await arxmintService.createL402Invoice(
      amountSats,
      bookId,
      `${bookTitle || bookId} (${format || 'ebook'})`
    );
    if (arxmintAttempt && arxmintAttempt.invoice) {
      invoice = arxmintAttempt.invoice;
      macaroon = arxmintAttempt.macaroon || null;
    }

    // 2. Try BTCPay if ArxMint not available
    let btcpayInvoice = null;
    if (!invoice) {
      try {
        btcpayInvoice = await btcpayService.createInvoice(usdAmount, orderId, userEmail);
      } catch (btcErr) {
        console.warn('[checkout/arxmint] BTCPay unavailable:', btcErr.message);
      }
    }

    // 3. Manual wallet address fallback
    const walletAddress = process.env.BTC_ADDRESS || null;

    const paymentMethod = invoice ? 'arxmint_lightning' : btcpayInvoice ? 'btcpay' : 'manual_btc';

    // Create order record
    await orderService.createOrder({
      orderId,
      customerEmail: userEmail,
      bookId,
      bookTitle: bookTitle || bookId,
      bookAuthor: bookAuthor || '',
      format: format || 'ebook',
      price: usdAmount,
      currency: 'USD',
      metadata: {
        paymentMethod,
        arxmintInvoice: invoice || null,
        btcpayInvoiceId: btcpayInvoice?.invoiceId || null,
        walletAddress: walletAddress || null,
        brandId: brandId || null,
        createdAt: new Date().toISOString(),
      }
    });

    if (invoice) {
      return res.json({
        success: true,
        orderId,
        paymentMethod: 'arxmint_lightning',
        invoice,
        macaroon,
        amountUsd: usdAmount,
        statusUrl: `/api/checkout/order/${orderId}`,
      });
    }

    if (btcpayInvoice) {
      return res.json({
        success: true,
        orderId,
        paymentMethod: 'btcpay',
        btcpayCheckoutUrl: btcpayInvoice.checkoutUrl,
        btcpayInvoiceId: btcpayInvoice.invoiceId,
        amountUsd: usdAmount,
        statusUrl: `/api/checkout/order/${orderId}`,
      });
    }

    // Manual BTC fallback — show wallet address + BIP21 QR
    const bip21 = walletAddress ? `bitcoin:${walletAddress}` : null;
    res.json({
      success: true,
      orderId,
      paymentMethod: 'manual_btc',
      address: walletAddress,
      amountUsd: usdAmount,
      bip21,
      instructions: {
        step1: walletAddress
          ? `Send $${usdAmount} USD equivalent in BTC to: ${walletAddress}`
          : 'Bitcoin address not configured — contact support',
        step2: `Include order ID in memo: ${orderId}`,
        step3: 'Email payment proof to orders@teneo.market with subject: Order ' + orderId,
        step4: 'Download link sent within 1-24 hours after verification',
      },
      statusUrl: `/api/checkout/order/${orderId}`,
    });
  } catch (error) {
    console.error('[checkout/arxmint] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to create Lightning checkout', message: safeMessage(error) });
  }
});

// POST /api/checkout/shipping-rates
// Returns Printful shipping rate estimates for physical/POD items in the cart.
// Body: { items: [{variantId, quantity}], address: {address1, city, country_code, zip, state_code?} }
// Digital-only carts (no variantId) return an empty rates array immediately.
const shippingRatesLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : rateLimit({ windowMs: WEBHOOK_RATE_LIMIT_WINDOW_MS, max: WEBHOOK_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });

router.post('/shipping-rates', shippingRatesLimiter, async (req, res) => {
  try {
    const { items, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array is required' });
    }

    // Filter to items that have a Printful variant ID (physical/POD only)
    const physicalItems = items.filter(i => i.variantId);
    if (physicalItems.length === 0) {
      return res.json({ success: true, rates: [], message: 'No physical items in cart' });
    }

    if (!address || !address.address1 || !address.city || !address.country_code || !address.zip) {
      return res.status(400).json({
        success: false,
        error: 'address.address1, city, country_code, and zip are required for shipping estimates'
      });
    }

    const rates = await shippingService.getShippingRates(physicalItems, address);

    if (rates === null) {
      // Printful provider not configured — graceful fallback
      return res.json({ success: true, rates: [], fallback: true, message: 'Shipping calculated at checkout' });
    }

    return res.json({ success: true, rates });
  } catch (error) {
    console.error('[shipping-rates] Error:', error.message);
    // Non-fatal: return fallback so checkout can still proceed
    return res.json({ success: true, rates: [], fallback: true, message: 'Shipping calculated at checkout' });
  }
});

// ─── Store product checkout (AI-generated stores) ────────────────────────────

/**
 * POST /api/checkout/store-product
 * Creates a Stripe Checkout session for a product in an AI-generated store.
 * Looks up price server-side from store_products — never trusts client.
 * Body: { productId, userEmail }
 */
router.post('/store-product', checkoutLimiter, async (req, res) => {
  try {
    const { productId, userEmail } = req.body;

    if (!productId || !userEmail) {
      return res.status(400).json({ success: false, error: 'productId and userEmail are required' });
    }
    if (!isValidEmail(userEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email address required' });
    }

    // Look up product server-side — never trust client-supplied price
    const product = await new Promise((resolve, reject) => {
      db.get(
        'SELECT sp.*, s.status AS store_status FROM store_products sp JOIN stores s ON sp.store_id = s.id WHERE sp.id = ?',
        [productId],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    if (product.store_status !== 'published') {
      return res.status(400).json({ success: false, error: 'Store is not published' });
    }

    const stripeHealth = await stripeHealthService.checkStripeHealth();
    if (!stripeHealth.healthy) {
      return res.status(503).json({
        success: false,
        stripeDown: true,
        fallbackUrl: '/checkout/crypto',
        message: 'Stripe payment temporarily unavailable',
      });
    }

    const orderId = `store_${Date.now()}_${productId}`;
    const unitAmountCents = Math.round(product.price * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: userEmail,
      client_reference_id: orderId,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            ...(product.description && { description: product.description }),
          },
          unit_amount: unitAmountCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3001'}/cancel.html`,
      metadata: {
        orderId,
        productId,
        productType: 'store_product',
        storeId: product.store_id,
        userEmail,
      },
    });

    await orderService.createOrder({
      orderId,
      stripeSessionId: session.id,
      customerEmail: userEmail,
      bookId: productId,
      bookTitle: product.name,
      bookAuthor: '',
      format: product.type || 'digital',
      price: product.price,
      currency: 'USD',
      metadata: {
        productType: 'store_product',
        storeId: product.store_id,
        createdAt: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      orderId,
    });
  } catch (error) {
    console.error('[checkout/store-product] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to create checkout session', message: safeMessage(error) });
  }
});

// Basic health check for monitoring
router.get('/health', async (req, res) => {
  try {
    await stripe.paymentIntents.list({ limit: 1 });
    res.json({
      status: 'healthy',
      stripe: 'connected',
      environment: isProduction ? 'production' : 'development'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: safeMessage(error)
    });
  }
});

module.exports = router;
