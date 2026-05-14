'use strict';

/**
 * Archetype templates for territory-driven storefront scaffolding.
 *
 * Each template returns a partial brand config that gets deep-merged with the
 * territory-derived base config. Templates only override fields where the
 * archetype meaningfully diverges (theme, hero copy, feature flags). Anything
 * left undefined falls through to AUTHORITY_BRAND, which is the catch-all
 * default used by the Capability Restoration Catalog's first claim tier.
 *
 * Referenced by `services/territoryStorefrontService.js` and the
 * `marketplace.scaffold-storefront` ai-invoke endpoint.
 */

const AUTHORITY_BRAND = {
  theme: {
    primaryColor: '#1a365d',
    secondaryColor: '#c89b3c',
    accentColor: '#2c5282',
    backgroundColor: '#fafafa',
    surfaceColor: '#ffffff',
    textColor: '#1a202c',
    textSecondary: '#4a5568',
    borderColor: '#e2e8f0',
    fontFamily: "'Source Serif Pro', Georgia, serif",
    headingFont: "'Playfair Display', Georgia, serif",
  },
  features: {
    newsletter: true,
    testimonials: true,
    freeGift: true,
    leadCapture: true,
    booking: false,
    community: false,
    courses: false,
  },
  copy: {
    ctaButton: 'Read the Books',
    newsletterTitle: 'Get the Next Chapter First',
    newsletterDescription: 'Subscribe for new releases and field notes from the work.',
  },
};

const COMMUNITY_BRAND = {
  theme: {
    primaryColor: '#2f855a',
    secondaryColor: '#ed8936',
    accentColor: '#38a169',
    backgroundColor: '#fffaf0',
    surfaceColor: '#ffffff',
    textColor: '#1a202c',
    fontFamily: "'Inter', -apple-system, sans-serif",
    headingFont: "'Fraunces', Georgia, serif",
  },
  features: {
    newsletter: true,
    testimonials: true,
    freeGift: true,
    community: true,
    leadCapture: false,
    booking: false,
    courses: false,
  },
  copy: {
    ctaButton: 'Join the Circle',
    newsletterTitle: 'Join the Community',
    newsletterDescription: 'Weekly notes for people doing this work alongside you.',
  },
};

const EDUCATION_PRODUCT = {
  theme: {
    primaryColor: '#2b6cb0',
    secondaryColor: '#d69e2e',
    accentColor: '#3182ce',
    backgroundColor: '#f7fafc',
    surfaceColor: '#ffffff',
    textColor: '#1a202c',
    fontFamily: "'Inter', -apple-system, sans-serif",
    headingFont: "'Inter', -apple-system, sans-serif",
  },
  features: {
    courses: true,
    newsletter: true,
    leadCapture: true,
    testimonials: true,
    community: true,
    freeGift: false,
    booking: false,
  },
  copy: {
    ctaButton: 'Start Learning',
    newsletterTitle: 'Free Lessons in Your Inbox',
    newsletterDescription: 'One short lesson a week. Unsubscribe anytime.',
  },
};

const SERVICE_BUSINESS = {
  theme: {
    primaryColor: '#2d3748',
    secondaryColor: '#c89b3c',
    accentColor: '#4a5568',
    backgroundColor: '#ffffff',
    surfaceColor: '#f7fafc',
    textColor: '#1a202c',
    fontFamily: "'Inter', -apple-system, sans-serif",
    headingFont: "'Source Serif Pro', Georgia, serif",
  },
  features: {
    booking: true,
    leadCapture: true,
    testimonials: true,
    newsletter: true,
    freeGift: true,
    community: false,
    courses: false,
  },
  copy: {
    ctaButton: 'Book a Consultation',
    newsletterTitle: 'Free Resources for the Work',
    newsletterDescription: 'Get the templates, scripts, and frameworks the books reference.',
  },
};

const MEDIA_BRAND = {
  theme: {
    primaryColor: '#1a202c',
    secondaryColor: '#ed8936',
    accentColor: '#e53e3e',
    backgroundColor: '#ffffff',
    surfaceColor: '#fafafa',
    textColor: '#1a202c',
    fontFamily: "'Source Serif Pro', Georgia, serif",
    headingFont: "'Inter', -apple-system, sans-serif",
  },
  features: {
    newsletter: true,
    testimonials: false,
    freeGift: false,
    leadCapture: false,
    community: false,
    courses: false,
    booking: false,
    archives: true,
  },
  copy: {
    ctaButton: 'Read the Latest',
    newsletterTitle: 'The Briefing',
    newsletterDescription: 'New investigations and essays, delivered weekly.',
  },
};

const KDP_CATALOG = {
  theme: AUTHORITY_BRAND.theme,
  features: {
    newsletter: true,
    testimonials: true,
    freeGift: false,
    leadCapture: false,
    booking: false,
    community: false,
    courses: false,
  },
  copy: {
    ctaButton: 'Browse the Catalog',
    newsletterTitle: 'New Releases',
    newsletterDescription: 'Get notified when new titles in this catalog publish.',
  },
};

const TEMPLATES = {
  AUTHORITY_BRAND,
  COMMUNITY_BRAND,
  EDUCATION_PRODUCT,
  SERVICE_BUSINESS,
  MEDIA_BRAND,
  KDP_CATALOG,
};

function getTemplate(archetype) {
  return TEMPLATES[archetype] || AUTHORITY_BRAND;
}

function listArchetypes() {
  return Object.keys(TEMPLATES);
}

/**
 * Render a `:root` + `body.{slug}-theme` CSS file from a brand config.
 * Matches the convention used by `true-earth/css/theme.css` and is consumed by
 * `marketplace/frontend/js/brand-manager.js` (and an inline applier added to
 * `store.html`) so scaffolded storefronts actually look themed instead of
 * defaulting to the generic page styling.
 */
function buildThemeCss(slug, brandConfig) {
  const theme = (brandConfig && brandConfig.theme) || {};
  const safeSlug = String(slug || '').replace(/[^a-z0-9-]/g, '');
  const primary = theme.primaryColor || '#1a365d';
  const secondary = theme.secondaryColor || '#c89b3c';
  const accent = theme.accentColor || primary;
  const bg = theme.backgroundColor || '#FFFFFF';
  const surface = theme.surfaceColor || '#F9FAFB';
  const text = theme.textColor || '#111827';
  const textSecondary = theme.textSecondary || '#4B5563';
  const border = theme.borderColor || '#E5E7EB';
  const font = theme.fontFamily || theme.font || "'Inter', -apple-system, sans-serif";
  const headingFont = theme.headingFont || font;

  return `/* Auto-generated theme for ${brandConfig?.name || safeSlug} */
:root {
  --brand-primary-color: ${primary};
  --brand-secondary-color: ${secondary};
  --brand-accent-color: ${accent};
  --brand-background-color: ${bg};
  --brand-surface-color: ${surface};
  --brand-text-color: ${text};
  --brand-text-secondary: ${textSecondary};
  --brand-border-color: ${border};
  --brand-font-family: ${font};
  --brand-heading-font: ${headingFont};
}

body.${safeSlug}-theme {
  background-color: ${bg};
  color: ${text};
  font-family: ${font};
}

body.${safeSlug}-theme .hero,
body.${safeSlug}-theme header {
  background-color: ${surface};
  border-color: ${border};
}

body.${safeSlug}-theme .hero h1,
body.${safeSlug}-theme h1,
body.${safeSlug}-theme h2,
body.${safeSlug}-theme h3 {
  color: ${primary};
  font-family: ${headingFont};
}

body.${safeSlug}-theme .hero .tagline,
body.${safeSlug}-theme .nav a:hover {
  color: ${accent};
}

body.${safeSlug}-theme .cta-button,
body.${safeSlug}-theme button.primary,
body.${safeSlug}-theme .btn-primary {
  background-color: ${primary};
  color: ${bg};
  border: 1px solid ${primary};
}

body.${safeSlug}-theme .cta-button:hover,
body.${safeSlug}-theme button.primary:hover,
body.${safeSlug}-theme .btn-primary:hover {
  background-color: ${accent};
  border-color: ${accent};
}

body.${safeSlug}-theme .book-card,
body.${safeSlug}-theme .card {
  background-color: ${bg};
  border: 1px solid ${border};
}

body.${safeSlug}-theme .book-title,
body.${safeSlug}-theme .card-title {
  color: ${primary};
  font-family: ${headingFont};
}

body.${safeSlug}-theme .book-description,
body.${safeSlug}-theme .text-muted {
  color: ${textSecondary};
}
`;
}

module.exports = { getTemplate, listArchetypes, TEMPLATES, buildThemeCss };
