-- =====================================================
-- OpenBazaar AI — Supabase Migration
-- =====================================================
-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ncddvxglmnnfagyyupeu/sql
--
-- NOTE: Supabase reserves "users" for auth.users.
-- Our app users table is called "profiles".
-- =====================================================

-- =====================================================
-- 1. PROFILES & AUTH
-- =====================================================

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, -- UUID
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    auth_provider TEXT DEFAULT 'local',
    teneo_user_id TEXT UNIQUE,
    nostr_pubkey TEXT UNIQUE,
    avatar_url TEXT,
    bio TEXT,
    credits INTEGER DEFAULT 0,
    lifetime_spending DECIMAL(12,2) DEFAULT 0,
    email_verified BOOLEAN DEFAULT FALSE,
    account_status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ,
    signup_source TEXT,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_teneo_id ON profiles(teneo_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_nostr_pubkey ON profiles(nostr_pubkey);
CREATE INDEX IF NOT EXISTS idx_profiles_provider ON profiles(auth_provider);

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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_teneo_listings_book ON teneo_marketplace_listings(teneo_book_id);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_author ON teneo_marketplace_listings(author_user_id);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_status ON teneo_marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_teneo_listings_slug ON teneo_marketplace_listings(slug);

CREATE TABLE IF NOT EXISTS teneo_marketplace_storefronts (
    storefront_id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    territory_id TEXT NOT NULL,
    territory_name TEXT,
    claim_id TEXT,
    author_user_id TEXT NOT NULL,
    archetype TEXT NOT NULL,
    config_json TEXT NOT NULL,
    publishing_code_flags_json TEXT,
    public_url TEXT,
    status TEXT NOT NULL DEFAULT 'live',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(territory_id, author_user_id)
);

CREATE INDEX IF NOT EXISTS idx_teneo_storefronts_territory ON teneo_marketplace_storefronts(territory_id);
CREATE INDEX IF NOT EXISTS idx_teneo_storefronts_author ON teneo_marketplace_storefronts(author_user_id);
CREATE INDEX IF NOT EXISTS idx_teneo_storefronts_status ON teneo_marketplace_storefronts(status);

-- Runtime-scaffolded brand storefronts (Capability Restoration Catalog claims).
-- Mirrors schema.sql for Postgres/Supabase deployments where serverless
-- functions cannot write brand folders to the read-only app filesystem.
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teneo_brands_territory ON teneo_marketplace_brands(territory_id);
CREATE INDEX IF NOT EXISTS idx_teneo_brands_status ON teneo_marketplace_brands(status);

CREATE TABLE IF NOT EXISTS magic_links (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
CREATE INDEX IF NOT EXISTS idx_magic_links_user ON magic_links(user_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type TEXT DEFAULT 'Bearer',
    expires_at TIMESTAMPTZ,
    scope TEXT,
    provider TEXT DEFAULT 'teneo-auth',
    provider_user_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    session_data JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    auth_provider TEXT,
    ip_address TEXT,
    user_agent TEXT,
    success BOOLEAN DEFAULT TRUE,
    failure_reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);

-- =====================================================
-- 2. ORDERS & PAYMENTS
-- =====================================================

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    download_expiry TIMESTAMPTZ,
    refund_status TEXT,
    refund_amount DECIMAL(10,2),
    refund_reason TEXT,
    lulu_print_job_id TEXT,
    printful_order_id TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    metadata JSONB,
    abandonment_email_sent_at TIMESTAMPTZ,
    order_type TEXT DEFAULT 'digital',
    shipping_address JSONB,
    shipping_method TEXT,
    shipping_cost DECIMAL(10,2) DEFAULT 0,
    contains_physical BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_lulu_print_job_id ON orders(lulu_print_job_id);
CREATE INDEX IF NOT EXISTS idx_orders_printful_order_id ON orders(printful_order_id);

CREATE TABLE IF NOT EXISTS download_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id TEXT NOT NULL,
    download_token TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    download_status TEXT NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    order_id TEXT,
    payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS printful_webhook_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id TEXT UNIQUE,
    event_type TEXT NOT NULL,
    printful_order_id TEXT,
    external_order_id TEXT,
    payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_event_id ON printful_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_order_id ON printful_webhook_events(printful_order_id);
CREATE INDEX IF NOT EXISTS idx_printful_webhooks_external_id ON printful_webhook_events(external_order_id);

CREATE TABLE IF NOT EXISTS refunds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    refund_id TEXT UNIQUE NOT NULL,
    order_id TEXT NOT NULL,
    stripe_refund_id TEXT,
    amount DECIMAL(10,2) NOT NULL,
    currency TEXT DEFAULT 'USD',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS email_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id TEXT NOT NULL,
    email_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS network_revenue_shares (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id TEXT NOT NULL,
    peer_node_id TEXT NOT NULL,
    peer_node_url TEXT,
    revenue_share_pct REAL NOT NULL DEFAULT 0.0,
    revenue_share_amount REAL,
    currency TEXT DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_revenue_shares_order ON network_revenue_shares(order_id);
CREATE INDEX IF NOT EXISTS idx_revenue_shares_status ON network_revenue_shares(status);

-- =====================================================
-- 3. COURSES
-- =====================================================

CREATE TABLE IF NOT EXISTS courses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    brand_id TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    price_cents INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_modules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    course_id BIGINT REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    order_index INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_lessons (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    module_id BIGINT REFERENCES course_modules(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content_type TEXT DEFAULT 'video',
    content_url TEXT,
    content_body TEXT,
    order_index INTEGER DEFAULT 0,
    is_free_preview BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS course_enrollments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    course_id BIGINT REFERENCES courses(id),
    user_email TEXT NOT NULL,
    order_id TEXT,
    enrolled_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    UNIQUE(course_id, user_email)
);

CREATE TABLE IF NOT EXISTS course_progress (
    enrollment_id BIGINT REFERENCES course_enrollments(id) ON DELETE CASCADE,
    lesson_id BIGINT REFERENCES course_lessons(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (enrollment_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS course_quizzes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id BIGINT REFERENCES course_lessons(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    passing_score INTEGER DEFAULT 70,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quiz_questions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quiz_id BIGINT NOT NULL REFERENCES course_quizzes(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type TEXT DEFAULT 'multiple_choice',
    correct_answer TEXT NOT NULL,
    options JSONB,
    order_index INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quiz_id BIGINT NOT NULL REFERENCES course_quizzes(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    score INTEGER NOT NULL,
    passed BOOLEAN NOT NULL,
    answers JSONB,
    attempted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_certificates (
    id TEXT PRIMARY KEY,
    course_id BIGINT NOT NULL REFERENCES courses(id),
    user_email TEXT NOT NULL,
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    verification_url TEXT,
    UNIQUE(course_id, user_email)
);

-- =====================================================
-- 4. EMAIL MARKETING
-- =====================================================

CREATE TABLE IF NOT EXISTS subscribers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    source TEXT,
    ip_address TEXT,
    user_agent TEXT,
    status TEXT DEFAULT 'active',
    confirmed BOOLEAN DEFAULT FALSE,
    confirm_token TEXT,
    unsubscribe_token TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

CREATE TABLE IF NOT EXISTS segments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'manual',
    rules JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO segments (name, description, type) VALUES
    ('All Subscribers', 'Everyone on the list', 'auto'),
    ('Leads', 'Gave email, no purchase yet', 'auto'),
    ('Buyers', 'Made at least one purchase', 'auto'),
    ('High Value Customers', '3+ purchases or $100+ spent', 'auto'),
    ('VIP', '10+ purchases or $500+ spent', 'auto'),
    ('Abandoned Cart', 'Added to cart, didnt buy', 'auto'),
    ('Recently Active', 'Engaged in last 30 days', 'auto'),
    ('Inactive', 'No engagement in 90+ days', 'auto')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriber_segments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    segment_id BIGINT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(subscriber_id, segment_id)
);

CREATE TABLE IF NOT EXISTS tags (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#3B82F6',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tags (name, color) VALUES
    ('book_buyer', '#10B981'),
    ('high_intent', '#EF4444'),
    ('email_engaged', '#14B8A6'),
    ('email_inactive', '#9CA3AF')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriber_tags (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(subscriber_id, tag_id)
);

CREATE TABLE IF NOT EXISTS email_templates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT,
    preview_text TEXT,
    from_name TEXT DEFAULT 'OpenBazaar AI',
    from_email TEXT DEFAULT 'noreply@openbazaar.ai',
    reply_to TEXT,
    category TEXT,
    variables JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_sequences (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    trigger_event TEXT,
    trigger_value TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO email_sequences (name, description, trigger_event, active) VALUES
    ('Welcome Sequence', 'New subscriber welcome series', 'signup', TRUE),
    ('Book Buyer Sequence', 'Post-purchase nurture', 'purchase', TRUE),
    ('Abandoned Cart Sequence', 'Cart recovery emails', 'abandoned_cart', TRUE),
    ('Re-engagement', 'Win back inactive subscribers', 'inactive', TRUE)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS sequence_emails (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sequence_id BIGINT NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
    order_number INTEGER NOT NULL,
    delay_days INTEGER DEFAULT 0,
    delay_hours INTEGER DEFAULT 0,
    template_id BIGINT NOT NULL REFERENCES email_templates(id),
    subject_override TEXT,
    active BOOLEAN DEFAULT TRUE,
    UNIQUE(sequence_id, order_number)
);

CREATE TABLE IF NOT EXISTS subscriber_sequences (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    sequence_id BIGINT NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS email_broadcasts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    template_id BIGINT NOT NULL REFERENCES email_templates(id),
    segment_ids TEXT,
    tag_ids TEXT,
    subject_override TEXT,
    scheduled_at TIMESTAMPTZ,
    status TEXT DEFAULT 'draft',
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS email_sends (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email_type TEXT NOT NULL,
    sequence_email_id BIGINT REFERENCES sequence_emails(id),
    broadcast_id BIGINT REFERENCES email_broadcasts(id),
    template_id BIGINT REFERENCES email_templates(id),
    subject TEXT NOT NULL,
    from_email TEXT,
    to_email TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    clicked_at TIMESTAMPTZ,
    complained_at TIMESTAMPTZ,
    bounced_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_sends_subscriber ON email_sends(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_sends(status);

CREATE TABLE IF NOT EXISTS email_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('open', 'click')),
    send_id BIGINT NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
    subscriber_id BIGINT REFERENCES subscribers(id) ON DELETE SET NULL,
    url TEXT,
    ip_address TEXT,
    user_agent TEXT,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriber_activity (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subscriber_id BIGINT NOT NULL UNIQUE REFERENCES subscribers(id) ON DELETE CASCADE,
    total_emails_sent INTEGER DEFAULT 0,
    total_emails_opened INTEGER DEFAULT 0,
    total_emails_clicked INTEGER DEFAULT 0,
    total_purchases INTEGER DEFAULT 0,
    total_revenue DECIMAL(10,2) DEFAULT 0,
    last_email_sent_at TIMESTAMPTZ,
    last_email_opened_at TIMESTAMPTZ,
    last_email_clicked_at TIMESTAMPTZ,
    last_purchase_at TIMESTAMPTZ,
    last_active_at TIMESTAMPTZ,
    engagement_score INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 5. FUNNELS
-- =====================================================

CREATE TABLE IF NOT EXISTS store_funnels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    brand_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    user_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS funnel_drafts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    funnel_id BIGINT REFERENCES store_funnels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    funnel_name TEXT NOT NULL,
    template TEXT,
    variables JSONB,
    context JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, funnel_name)
);

CREATE TABLE IF NOT EXISTS funnel_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    funnel_id TEXT NOT NULL,
    page_slug TEXT,
    event_type TEXT NOT NULL,
    session_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_funnel ON funnel_events(funnel_id);

CREATE TABLE IF NOT EXISTS analytics_funnels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    steps JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS funnel_conversions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    funnel_id BIGINT NOT NULL REFERENCES analytics_funnels(id),
    session_id TEXT NOT NULL,
    subscriber_id BIGINT REFERENCES subscribers(id) ON DELETE SET NULL,
    current_step INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    data JSONB,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- =====================================================
-- 6. ANALYTICS
-- =====================================================

CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL,
    subscriber_id BIGINT REFERENCES subscribers(id) ON DELETE SET NULL,
    session_id TEXT,
    user_id TEXT,
    page_url TEXT,
    referrer TEXT,
    ip_address TEXT,
    user_agent TEXT,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);

-- =====================================================
-- 7. PRINT ON DEMAND (LULU)
-- =====================================================

CREATE TABLE IF NOT EXISTS book_formats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id TEXT NOT NULL,
    format_type TEXT NOT NULL,
    pod_package_id TEXT,
    page_count INTEGER,
    base_price DECIMAL(10,2),
    our_price DECIMAL(10,2),
    printable_id TEXT,
    lulu_product_url TEXT,
    cover_url TEXT,
    interior_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_book_formats_book ON book_formats(book_id);

CREATE TABLE IF NOT EXISTS print_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    format_type TEXT NOT NULL,
    lulu_print_job_id TEXT UNIQUE,
    lulu_order_id TEXT,
    status TEXT DEFAULT 'pending',
    quantity INTEGER DEFAULT 1,
    shipping_method TEXT,
    shipping_cost DECIMAL(10,2),
    tracking_url TEXT,
    tracking_id TEXT,
    error_message TEXT,
    webhook_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    production_started_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);

CREATE TABLE IF NOT EXISTS lulu_webhook_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    print_job_id TEXT,
    payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- =====================================================
-- 8. SYSTEM
-- =====================================================

CREATE TABLE IF NOT EXISTS cron_execution_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    message TEXT,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 9. AUTO-UPDATE TRIGGERS
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER update_profiles_timestamp
        BEFORE UPDATE ON profiles
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_orders_timestamp
        BEFORE UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_courses_timestamp
        BEFORE UPDATE ON courses
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_subscribers_timestamp
        BEFORE UPDATE ON subscribers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_email_templates_timestamp
        BEFORE UPDATE ON email_templates
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_email_sequences_timestamp
        BEFORE UPDATE ON email_sequences
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- AI STORE BUILDER
-- =====================================================

CREATE TABLE IF NOT EXISTS stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id),
    slug TEXT UNIQUE NOT NULL,
    config JSONB NOT NULL,
    html TEXT,
    status TEXT DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    description TEXT,
    type TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stores_user ON stores(user_id);
CREATE INDEX IF NOT EXISTS idx_stores_slug ON stores(slug);
CREATE INDEX IF NOT EXISTS idx_store_products_store ON store_products(store_id);

DO $$ BEGIN
    CREATE TRIGGER update_stores_timestamp
        BEFORE UPDATE ON stores
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Email capture for store visitor sign-ups
CREATE TABLE IF NOT EXISTS store_subscribers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    source TEXT DEFAULT 'storefront',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, email)
);

CREATE INDEX IF NOT EXISTS idx_store_subscribers_store ON store_subscribers(store_id);
CREATE INDEX IF NOT EXISTS idx_store_subscribers_email ON store_subscribers(email);

-- Product versions — tracks file updates for digital products
-- Buyers always receive the latest version via their download link.
CREATE TABLE IF NOT EXISTS product_versions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    version TEXT NOT NULL,
    file_path TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_versions_product ON product_versions(product_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_product_versions_created ON product_versions(created_at DESC);

-- =====================================================
-- MERCHANT FULFILLMENT (multi-tenant Printful etc.)
-- =====================================================

CREATE TABLE IF NOT EXISTS merchant_fulfillment_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    credentials_encrypted JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    connected_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,
    product_count INT DEFAULT 0,
    UNIQUE(merchant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_mfp_merchant_provider
    ON merchant_fulfillment_providers(merchant_id, provider);

CREATE TABLE IF NOT EXISTS fulfillment_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    thumbnail_url TEXT,
    retail_price DECIMAL(10,2),
    retail_price_sats INT,
    is_active BOOLEAN DEFAULT TRUE,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    variants JSONB NOT NULL DEFAULT '[]',
    UNIQUE(merchant_id, provider, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_fp_merchant
    ON fulfillment_products(merchant_id);

CREATE TABLE IF NOT EXISTS fulfillment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    order_id TEXT NOT NULL,
    external_order_id TEXT,
    status TEXT DEFAULT 'pending',
    tracking_number TEXT,
    tracking_url TEXT,
    carrier TEXT,
    recipient JSONB NOT NULL,
    items JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fo_merchant ON fulfillment_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_fo_order_id ON fulfillment_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_fo_external_order_id ON fulfillment_orders(external_order_id);

-- =====================================================
-- 10. SCHEMA MIGRATIONS (idempotent column additions)
-- Run these after initial table creation to sync with
-- columns added to the SQLite schema since first deploy.
-- =====================================================

-- Orders: state machine columns (added with payment-agnostic order state machine)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS state_transitions JSONB DEFAULT '[]';

-- Orders: Stripe customer tracking columns
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;

-- Orders: abandonment email stage tracking (0=none, 1=1h sent, 2=24h sent, 3=72h sent)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS abandonment_email_stage INTEGER DEFAULT 0;

-- Stores: NIP-05 Nostr identity column (merchant's hex pubkey for NIP-05 DNS verification)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT;

-- Store builds: delivery artifacts and QA evidence columns
ALTER TABLE store_builds ADD COLUMN IF NOT EXISTS rendered_config JSONB;
ALTER TABLE store_builds ADD COLUMN IF NOT EXISTS delivery_url TEXT;
ALTER TABLE store_builds ADD COLUMN IF NOT EXISTS qa_results JSONB;
ALTER TABLE store_builds ADD COLUMN IF NOT EXISTS artifact_summary JSONB;

-- =====================================================
-- DONE. 47 tables + migrations. "profiles" = app users.
-- =====================================================
