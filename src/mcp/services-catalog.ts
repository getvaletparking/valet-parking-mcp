/**
 * 9 canonical valet service triples, baked into the Worker bundle.
 *
 * Source of truth: apps/frontend/src/data/services.ts (the 9 `Service`
 * entries). These are copied (NOT runtime-imported) per Plan 10.1-CONTEXT.md
 * decision D-10.1-02 because cross-app imports between the Astro frontend
 * package and the Workers package violate the monorepo package boundary
 * (the Worker bundles independently and cannot reach into apps/frontend at
 * runtime or build time).
 *
 * The `as const` annotation narrows the slug type so downstream tool files
 * (Wave 10.3 / 10.4 service-filter validation) can derive their zod enum
 * schemas from this same constant via `typeof SERVICES_CATALOG[number]['slug']`.
 *
 * If the frontend taxonomy ever gains a 10th slug, both this file and the
 * frontend file must be edited together, there is no runtime drift check
 * because the file is a literal copy. The em-dash audit (DOCS-09, Wave 10.6)
 * verifies displayName strings remain em-dash free.
 */
export const SERVICES_CATALOG = [
  { slug: 'wedding-valet', displayName: 'Wedding Valet', category: 'event' },
  { slug: 'corporate-event-valet', displayName: 'Corporate Event Valet', category: 'corporate' },
  { slug: 'private-event-valet', displayName: 'Private Event Valet', category: 'event' },
  { slug: 'funeral-valet', displayName: 'Funeral Valet', category: 'event' },
  { slug: 'hotel-resort-valet', displayName: 'Hotel & Resort Valet', category: 'hospitality' },
  { slug: 'restaurant-valet', displayName: 'Restaurant Valet', category: 'hospitality' },
  {
    slug: 'hospital-medical-valet',
    displayName: 'Hospital & Medical Valet',
    category: 'medical',
  },
  { slug: 'major-venue-valet', displayName: 'Major Venue Valet', category: 'venue' },
  { slug: 'general-valet', displayName: 'General Valet Service', category: 'general' },
] as const

export type ServiceCatalogEntry = (typeof SERVICES_CATALOG)[number]
export type ServiceSlug = ServiceCatalogEntry['slug']
export type ServiceCategory = ServiceCatalogEntry['category']

/**
 * Build-time constant baked into responses' data_freshness stamp.
 * Updated whenever this file changes (treat as the catalog's version).
 * Format: YYYY-MM-DD.
 */
export const SERVICES_CATALOG_INDEXED_AT = '2026-06-04'
