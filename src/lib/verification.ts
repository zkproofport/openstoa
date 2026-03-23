/**
 * @deprecated Use verification-cache.ts (Redis-based) instead.
 *
 * This file previously stored verification records in the user_verifications DB table.
 * It has been replaced by Redis-based caching for privacy reasons:
 * - No PII (domain, country) stored in the database
 * - Only hashed values in Redis with 30-day TTL
 * - Existing topic memberships are not affected by cache expiry
 *
 * The user_verifications table still exists in schema.ts for migration compatibility
 * but is no longer written to or read from.
 */
