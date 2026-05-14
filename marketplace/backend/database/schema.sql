-- Store builds table (managed-service commercialization layer)
CREATE TABLE IF NOT EXISTS store_builds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  intake_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'intake',
  store_id TEXT REFERENCES stores(id),
  tier TEXT,
  payment_session_id TEXT,
  operator_notes TEXT,
  error_message TEXT,
  rendered_config TEXT,
  delivery_url TEXT,
  qa_results TEXT,
  artifact_summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_store_builds_status ON store_builds(status);
CREATE INDEX IF NOT EXISTS idx_store_builds_created_at ON store_builds(created_at);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT,
    customer_email TEXT NOT NULL,
    customer_name TEXT,
    book_id TEXT NOT NULL,
    book_title TEXT NOT NULL,
    book_author TEXT NOT NULL,
    format TEXT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    currency TEXT DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT DEFAULT 'pending',
    fulfillment_status TEXT DEFAULT 'pending',
    download_token TEXT,
    download_count INTEGER DEFAULT 0,
    download_expiry DATETIME,
    refund_status TEXT,
    refund_amount DECIMAL(10,2),
    refund_reason TEXT,
    order_type TEXT DEFAULT 'digital',
    shipping_address TEXT,
    shipping_method TEXT,
    shipping_cost DECIMAL(10,2) DEFAULT 0,
    contains_physical BOOLEAN DEFAULT 0,
    lulu_print_job_id TEXT,
    printful_order_id TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    metadata TEXT,
    abandonment_email_sent_at DATETIME,
    abandonment_email_stage INTEGER DEFAULT 0, -- 0=none, 1=1h sent, 2=24h sent, 3=72h sent
    stripe_customer_id TEXT,
    stripe_payment_method_id TEXT,
    state TEXT DEFAULT 'pending',
    state_transitions TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    refunded_at DATETIME
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_lulu_print_job_id ON orders(lulu_print_job_id);
CREATE INDEX IF NOT EXISTS idx_orders_printful_order_id ON orders(printful_order_id);

-- Download logs table
CREATE TABLE IF NOT EXISTS download_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    download_token TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    download_status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- Payment events table (for webhook history)
CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    order_id TEXT,
    payload TEXT NOT NULL,
    processed BOOLEAN DEFAULT 0,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
);

-- Printful webhook events (for idempotency + audit trail)
CREATE TABLE IF NOT EXISTS printful_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    event_type TEXT NOT NULL,
    printful_order_id TEXT,
    external_order_id TEXT,
    payload TEXT NOT NULL,
    processed BOOLEAN DEFAULT 0,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_event_id ON printful_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_order_id ON printful_webhook_events(printful_order_id);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_external_id ON printful_webhook_events(external_order_id);

-- Refunds table
CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    refund_id TEXT UNIQUE NOT NULL,
    order_id TEXT NOT NULL,
    stripe_refund_id TEXT,
    amount DECIMAL(10,2) NOT NULL,
    currency TEXT DEFAULT 'USD',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- Email logs table
CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    email_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- Published books tracking table
CREATE TABLE IF NOT EXISTS published_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teneo_book_id TEXT NOT NULL,
    teneo_user_id TEXT NOT NULL,
    amazon_asin TEXT NOT NULL,
    amazon_url TEXT NOT NULL,
    
    -- Book metadata from Amazon API
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT,
    cover_image_url TEXT,
    publication_date DATE,
    page_count INTEGER,
    language TEXT DEFAULT 'en',
    
    -- Pricing and sales data
    current_price DECIMAL(10,2),
    currency TEXT DEFAULT 'USD',
    bestseller_rank INTEGER,
    category_rank INTEGER,
    primary_category TEXT,
    
    -- Review and rating data
    rating_average DECIMAL(3,2),
    rating_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    
    -- Status tracking
    verification_status TEXT NOT NULL DEFAULT 'pending',
    publication_status TEXT NOT NULL DEFAULT 'active',
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_data_fetch DATETIME,
    
    -- Metadata
    submission_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    UNIQUE(teneo_book_id, teneo_user_id),
    UNIQUE(amazon_asin)
);

-- Indexes for published books
CREATE INDEX IF NOT EXISTS idx_published_books_user ON published_books(teneo_user_id);
CREATE INDEX IF NOT EXISTS idx_published_books_status ON published_books(verification_status);
CREATE INDEX IF NOT EXISTS idx_published_books_created ON published_books(created_at);
CREATE INDEX IF NOT EXISTS idx_published_books_rank ON published_books(bestseller_rank);
CREATE INDEX IF NOT EXISTS idx_published_books_rating ON published_books(rating_average);

-- Teneo-generated listings pushed through /api/ai-invoke/marketplace.publish-book.
-- OpenBazaar is the public commerce source of truth; teneo-production keeps only
-- a mirror for user dashboards and ownership checks.
CREATE TABLE IF NOT EXISTS teneo_marketplace_listings (
    listing_id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    teneo_book_id TEXT UNIQUE NOT NULL,
    author_user_id TEXT NOT NULL,
    brand_id TEXT,
    niche TEXT,
    title TEXT NOT NULL,
    subtitle TEXT,
    author TEXT,
    description_md TEXT,
    cover_url TEXT,
    formats_json TEXT,
    amazon_asin TEXT,
    price_usd DECIMAL(10,2) DEFAULT 9.99,
    royalty_split_json TEXT,
    license_terms TEXT DEFAULT 'personal-use',
    status TEXT NOT NULL DEFAULT 'live',
    public_url TEXT,
    views INTEGER DEFAULT 0,
    add_to_cart INTEGER DEFAULT 0,
    purchases INTEGER DEFAULT 0,
    revenue_usd DECIMAL(12,2) DEFAULT 0,
    refunds INTEGER DEFAULT 0,
    unpublish_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    published_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_teneo_listings_book ON teneo_marketplace_listings(teneo_book_id);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_author ON teneo_marketplace_listings(author_user_id);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_status ON teneo_marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_slug ON teneo_marketplace_listings(slug);

-- Runtime-scaffolded brand storefronts (Capability Restoration Catalog claims).
-- Built-in brands like true-earth ship as files under marketplace/frontend/brands/;
-- scaffolded brands live here because @vercel/node serverless has a read-only
-- filesystem at runtime. Routes in storefront.js serve config/catalog/theme from
-- this table, falling back to FS for built-in brands.
CREATE TABLE IF NOT EXISTS teneo_marketplace_brands (
    slug TEXT PRIMARY KEY,
    territory_id TEXT,
    archetype TEXT,
    config_json TEXT NOT NULL,
    catalog_json TEXT NOT NULL,
    variables_json TEXT,
    theme_css TEXT,
    publishing_code_flags_json TEXT,
    public_url TEXT,
    catalog_url TEXT,
    status TEXT NOT NULL DEFAULT 'live',
    book_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_teneo_brands_territory ON teneo_marketplace_brands(territory_id);
CREATE INDEX IF NOT EXISTS idx_teneo_brands_status ON teneo_marketplace_brands(status);

-- Book ranking history table
CREATE TABLE IF NOT EXISTS book_ranking_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    bestseller_rank INTEGER,
    category_rank INTEGER,
    rating_average DECIMAL(3,2),
    rating_count INTEGER,
    review_count INTEGER,
    price DECIMAL(10,2),
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id)
);

-- Index for ranking history
CREATE INDEX IF NOT EXISTS idx_ranking_history_book_date ON book_ranking_history(published_book_id, recorded_at);

-- User authentication tokens for Teneo validation
CREATE TABLE IF NOT EXISTS teneo_auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expiry DATETIME,
    scope TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Progress tracking table for milestone goals
CREATE TABLE IF NOT EXISTS publication_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    milestone_name TEXT NOT NULL,
    target_count INTEGER NOT NULL,
    current_count INTEGER DEFAULT 0,
    description TEXT,
    reward_description TEXT,
    achieved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial milestone for 10,000 books
INSERT OR IGNORE INTO publication_milestones (milestone_name, target_count, description, reward_description) 
VALUES ('10K_BOOKS_GOAL', 10000, 'Community goal to publish 10,000 books on Amazon', 'Full marketplace network launch');

-- Cron execution log table
CREATE TABLE IF NOT EXISTS cron_execution_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    message TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for cron log
CREATE INDEX IF NOT EXISTS idx_cron_log_job_date ON cron_execution_log(job_name, executed_at);

-- Enhanced Amazon data table
CREATE TABLE IF NOT EXISTS book_amazon_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    
    -- Format and availability data
    formats_available TEXT, -- JSON: ["kindle", "paperback", "hardcover"]
    kindle_price DECIMAL(10,2),
    paperback_price DECIMAL(10,2),
    hardcover_price DECIMAL(10,2),
    
    -- Category rankings (JSON array)
    category_rankings TEXT, -- JSON: [{"category": "Business", "rank": 1234}, ...]
    
    -- Content analysis
    keywords_detected TEXT, -- JSON array of extracted keywords
    has_a_plus_content BOOLEAN DEFAULT 0,
    description_length INTEGER,
    
    -- Related products
    also_bought_asins TEXT, -- JSON array of related ASINs
    
    -- Review analysis
    review_sentiment_positive INTEGER DEFAULT 0,
    review_sentiment_negative INTEGER DEFAULT 0,
    review_keywords TEXT, -- JSON: {"positive": [...], "negative": [...]}
    
    -- Performance estimates
    estimated_daily_sales INTEGER,
    estimated_monthly_revenue DECIMAL(10,2),
    
    -- Tracking metadata
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_quality_score INTEGER DEFAULT 0, -- 0-100 based on data completeness
    
    FOREIGN KEY (published_book_id) REFERENCES published_books(id),
    UNIQUE(published_book_id)
);

-- Enhanced ranking history with categories
CREATE TABLE IF NOT EXISTS book_category_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    category_name TEXT NOT NULL,
    category_rank INTEGER NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id)
);

-- Price history tracking
CREATE TABLE IF NOT EXISTS book_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    format TEXT NOT NULL, -- 'kindle', 'paperback', 'hardcover'
    price DECIMAL(10,2) NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id)
);

-- Publisher notes for books
CREATE TABLE IF NOT EXISTS book_publisher_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    notes_markdown TEXT,
    publishing_tips TEXT,
    marketing_tactics TEXT,
    teneo_modifications TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id),
    UNIQUE(published_book_id, user_id)
);

-- Performance alerts
CREATE TABLE IF NOT EXISTS performance_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    published_book_id INTEGER NOT NULL,
    alert_type TEXT NOT NULL, -- 'bsr_improvement', 'new_review', 'best_rank', 'top_10k'
    alert_message TEXT NOT NULL,
    trigger_value TEXT, -- Store the specific value that triggered alert
    acknowledged BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id)
);

-- Daily performance digest data
CREATE TABLE IF NOT EXISTS daily_performance_digest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date DATE NOT NULL UNIQUE,
    
    -- Book of the day
    book_of_day_id INTEGER,
    book_of_day_improvement INTEGER,
    
    -- Mover and shaker
    mover_shaker_id INTEGER,
    mover_volatility DECIMAL(10,2),
    
    -- Review champion
    review_champion_id INTEGER,
    new_reviews_count INTEGER,
    
    -- Rising category
    rising_category TEXT,
    category_book_count INTEGER,
    
    -- Community stats
    total_books_published INTEGER,
    estimated_total_revenue DECIMAL(12,2),
    total_reviews INTEGER,
    average_rating DECIMAL(3,2),
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (book_of_day_id) REFERENCES published_books(id),
    FOREIGN KEY (mover_shaker_id) REFERENCES published_books(id),
    FOREIGN KEY (review_champion_id) REFERENCES published_books(id)
);

-- Book insights generated by AI analysis
CREATE TABLE IF NOT EXISTS book_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_book_id INTEGER NOT NULL,
    insight_type TEXT NOT NULL, -- 'pattern', 'comparison', 'optimization', 'trend'
    insight_title TEXT NOT NULL,
    insight_description TEXT NOT NULL,
    confidence_score DECIMAL(3,2), -- 0.0-1.0
    data_points TEXT, -- JSON with supporting data
    is_active BOOLEAN DEFAULT 1,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (published_book_id) REFERENCES published_books(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_amazon_data_book ON book_amazon_data(published_book_id);
CREATE INDEX IF NOT EXISTS idx_category_rankings_book_date ON book_category_rankings(published_book_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_history_book_date ON book_price_history(published_book_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user_ack ON performance_alerts(user_id, acknowledged);
CREATE INDEX IF NOT EXISTS idx_insights_book_active ON book_insights(published_book_id, is_active);

-- Publisher stats table
CREATE TABLE IF NOT EXISTS publisher_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    username TEXT,
    display_name TEXT,
    profile_bio TEXT,
    profile_image_url TEXT,
    social_twitter TEXT,
    social_linkedin TEXT,
    social_website TEXT,
    
    -- Publishing stats
    total_books INTEGER DEFAULT 0,
    verified_books INTEGER DEFAULT 0,
    best_bsr INTEGER,
    avg_bsr DECIMAL(12,2),
    total_reviews INTEGER DEFAULT 0,
    total_revenue DECIMAL(12,2) DEFAULT 0,
    avg_rating DECIMAL(3,2),
    
    -- Milestone tracking
    badges_earned TEXT, -- JSON array of badge IDs
    current_milestone INTEGER DEFAULT 5,
    next_milestone_progress INTEGER DEFAULT 0,
    rewards_earned INTEGER DEFAULT 0,
    free_generations_available INTEGER DEFAULT 0,
    
    -- Publishing velocity
    books_last_30_days INTEGER DEFAULT 0,
    books_last_7_days INTEGER DEFAULT 0,
    first_book_date DATE,
    last_book_date DATE,
    
    -- Profile settings
    profile_visibility TEXT DEFAULT 'public',
    show_stats BOOLEAN DEFAULT 1,
    show_books BOOLEAN DEFAULT 1,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for publisher stats
CREATE INDEX IF NOT EXISTS idx_publisher_stats_user ON publisher_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_publisher_stats_books ON publisher_stats(total_books DESC);
CREATE INDEX IF NOT EXISTS idx_publisher_stats_bsr ON publisher_stats(best_bsr ASC);
CREATE INDEX IF NOT EXISTS idx_publisher_stats_reviews ON publisher_stats(total_reviews DESC);

-- Publisher milestones table
CREATE TABLE IF NOT EXISTS publisher_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    milestone_type TEXT NOT NULL, -- '5', '10', '25', '50', '100', '250', '500'
    milestone_category TEXT DEFAULT 'books_published', -- 'books_published', 'reviews_earned', 'bsr_achieved'
    target_value INTEGER NOT NULL,
    current_value INTEGER DEFAULT 0,
    achieved_date DATETIME,
    reward_status TEXT DEFAULT 'pending', -- 'pending', 'granted', 'claimed'
    reward_description TEXT,
    badge_id TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, milestone_type, milestone_category),
    FOREIGN KEY (user_id) REFERENCES publisher_stats(user_id)
);

-- Index for milestones
CREATE INDEX IF NOT EXISTS idx_milestones_user_achieved ON publisher_milestones(user_id, achieved_date);
CREATE INDEX IF NOT EXISTS idx_milestones_type ON publisher_milestones(milestone_type, achieved_date);

-- Leaderboard cache table
CREATE TABLE IF NOT EXISTS leaderboard_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leaderboard_type TEXT NOT NULL, -- 'most_published', 'rising_stars', 'best_sellers', 'most_reviewed', 'velocity_leaders'
    user_id TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    rank INTEGER NOT NULL,
    value DECIMAL(12,2) NOT NULL,
    secondary_value DECIMAL(12,2), -- For additional display info
    badge_display TEXT, -- JSON of badges to show
    
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(leaderboard_type, user_id)
);

-- Indexes for leaderboard cache
CREATE INDEX IF NOT EXISTS idx_leaderboard_type_rank ON leaderboard_cache(leaderboard_type, rank);
CREATE INDEX IF NOT EXISTS idx_leaderboard_updated ON leaderboard_cache(last_updated);

-- Publisher rewards tracking
CREATE TABLE IF NOT EXISTS publisher_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    reward_type TEXT NOT NULL, -- 'free_generation', 'badge', 'milestone_bonus'
    reward_value INTEGER DEFAULT 1,
    earned_for TEXT, -- Description of what earned this reward
    milestone_achieved TEXT, -- Which milestone triggered this
    
    status TEXT DEFAULT 'available', -- 'available', 'claimed', 'expired'
    earned_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    claimed_date DATETIME,
    expires_date DATETIME,
    
    FOREIGN KEY (user_id) REFERENCES publisher_stats(user_id)
);

-- Index for rewards
CREATE INDEX IF NOT EXISTS idx_rewards_user_status ON publisher_rewards(user_id, status);

-- Insert default milestones for new publishers
INSERT OR IGNORE INTO publisher_milestones (user_id, milestone_type, milestone_category, target_value, reward_description, badge_id)
VALUES
('default', '5', 'books_published', 5, '1 free book generation', 'bronze_book'),
('default', '10', 'books_published', 10, '2 free book generations', 'silver_stack'),
('default', '25', 'books_published', 25, '5 free book generations', 'gold_trophy'),
('default', '50', 'books_published', 50, '10 free book generations', 'diamond'),
('default', '100', 'books_published', 100, '20 free book generations', 'crown'),
('default', '250', 'books_published', 250, '50 free book generations', 'rocket'),
('default', '500', 'books_published', 500, '100 free book generations', 'star');

-- Coupons table — server-side coupon codes with expiry and usage limits
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,         -- 'percentage' | 'fixed'
  amount REAL NOT NULL,       -- percentage (0-100) or fixed USD
  expires_at TEXT,            -- ISO datetime or NULL = never expires
  max_uses INTEGER,           -- NULL = unlimited
  used_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active);

-- Order bumps table — "add this for $X" upsell on checkout
CREATE TABLE IF NOT EXISTS order_bumps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_product_id TEXT,    -- NULL = show on all checkouts
  bump_product_name TEXT NOT NULL,
  bump_description TEXT,
  bump_price REAL NOT NULL,
  bump_stripe_price_id TEXT,  -- optional, for Stripe line items
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_bumps_active ON order_bumps(active);
CREATE INDEX IF NOT EXISTS idx_order_bumps_trigger ON order_bumps(trigger_product_id);

-- Upsells table — post-purchase one-click upsell offers
CREATE TABLE IF NOT EXISTS upsells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT,              -- trigger: product_id that was purchased (NULL = all products)
  upsell_product_id TEXT NOT NULL,
  upsell_product_name TEXT NOT NULL,
  headline TEXT NOT NULL,
  description TEXT,
  upsell_price_cents INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_upsells_product ON upsells(product_id);
CREATE INDEX IF NOT EXISTS idx_upsells_active ON upsells(active);

-- =====================================================
-- Merchant Fulfillment Provider Connections
-- =====================================================
CREATE TABLE IF NOT EXISTS merchant_fulfillment_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,               -- 'printful', 'printify', 'manual'
    credentials_encrypted TEXT NOT NULL,   -- JSON: { apiKey_encrypted, storeId, webhookSecret }
    is_active BOOLEAN DEFAULT 1,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_sync_at DATETIME,
    product_count INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mfp_merchant_provider
    ON merchant_fulfillment_providers(merchant_id, provider);
CREATE INDEX IF NOT EXISTS idx_mfp_provider
    ON merchant_fulfillment_providers(provider);

-- Synced products from fulfillment providers
CREATE TABLE IF NOT EXISTS fulfillment_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_product_id TEXT NOT NULL,     -- Printful sync product ID
    name TEXT NOT NULL,
    thumbnail_url TEXT,
    retail_price DECIMAL(10,2),
    retail_price_sats INTEGER,
    is_active BOOLEAN DEFAULT 1,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    variants TEXT NOT NULL DEFAULT '[]'    -- JSON: [{ id, name, price, sku, external_variant_id }]
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_merchant_provider_ext
    ON fulfillment_products(merchant_id, provider, external_product_id);
CREATE INDEX IF NOT EXISTS idx_fp_merchant
    ON fulfillment_products(merchant_id);

-- Orders sent to fulfillment providers
CREATE TABLE IF NOT EXISTS fulfillment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    order_id TEXT NOT NULL,                -- Our internal order ID
    external_order_id TEXT,                -- Printful order ID
    status TEXT DEFAULT 'pending',         -- pending, submitted, in_production, shipped, delivered, failed, canceled
    tracking_number TEXT,
    tracking_url TEXT,
    carrier TEXT,
    recipient TEXT NOT NULL,               -- JSON: { name, address1, city, ... }
    items TEXT NOT NULL,                   -- JSON: [{ sync_variant_id, quantity }]
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fo_merchant
    ON fulfillment_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_fo_order_id
    ON fulfillment_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_fo_external_order_id
    ON fulfillment_orders(external_order_id);

-- Federation network revenue shares table
-- Records the originating peer node that should receive a revenue share for each federated order
CREATE TABLE IF NOT EXISTS network_revenue_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(order_id),
    peer_node_id TEXT NOT NULL,
    peer_node_url TEXT,
    revenue_share_pct REAL NOT NULL DEFAULT 0.0,
    revenue_share_amount REAL,
    currency TEXT DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_network_revenue_shares_order_id
    ON network_revenue_shares(order_id);
CREATE INDEX IF NOT EXISTS idx_network_revenue_shares_peer_node_id
    ON network_revenue_shares(peer_node_id);
CREATE INDEX IF NOT EXISTS idx_network_revenue_shares_status
    ON network_revenue_shares(status);

-- License keys table — persistent software product protection
CREATE TABLE IF NOT EXISTS license_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,       -- e.g. ABCD-1234-EFGH-5678
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  max_activations INTEGER DEFAULT 3,
  activations INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_license_keys_key ON license_keys(key);
CREATE INDEX IF NOT EXISTS idx_license_keys_order ON license_keys(order_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_email ON license_keys(customer_email);

-- Referral codes table — each brand can have one referral code
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  referrer_brand_id TEXT NOT NULL,
  commission_rate_new REAL DEFAULT 0.15,
  commission_rate_repeat REAL DEFAULT 0.02,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_brand ON referral_codes(referrer_brand_id);

-- Referrals table — tracks referral events tied to orders
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_code TEXT NOT NULL,
  referred_order_id TEXT,
  referred_email TEXT,
  is_new_customer INTEGER DEFAULT 1,
  commission_amount REAL,
  status TEXT DEFAULT 'pending',  -- pending | paid | cancelled
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_order ON referrals(referred_order_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- Product versions table — tracks file updates for digital products
CREATE TABLE IF NOT EXISTS product_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  version TEXT NOT NULL,
  file_path TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_product_versions_product ON product_versions(product_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_product_versions_created ON product_versions(created_at);

-- L402 payment records — Lightning invoice paywall credentials
CREATE TABLE IF NOT EXISTS l402_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_hash TEXT UNIQUE NOT NULL,
  preimage TEXT,
  amount_sat INTEGER NOT NULL,
  resource_path TEXT NOT NULL,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_l402_hash ON l402_payments(payment_hash);

-- Membership tiers table — creator-defined subscription tiers per store
CREATE TABLE IF NOT EXISTS membership_tiers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  store_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  price_monthly REAL NOT NULL,
  stripe_price_id TEXT,
  features TEXT DEFAULT '[]',       -- JSON array of feature strings
  content_access TEXT DEFAULT '[]', -- JSON array of product IDs gated to this tier
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_membership_tiers_store ON membership_tiers(store_slug, active);

-- Subscriptions table — active subscriber records
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  customer_email TEXT NOT NULL,
  store_slug TEXT NOT NULL,
  tier_id TEXT NOT NULL REFERENCES membership_tiers(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  status TEXT DEFAULT 'active',       -- active | cancelled | past_due
  current_period_end INTEGER,         -- Unix timestamp
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(customer_email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_store ON subscriptions(store_slug);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
