/**
 * vitest unit tests for src/mcp/url.ts decorateOperatorUrl helper.
 * Plan 10.2-03 Task 1.
 *
 * Coverage:
 *   1. Bare URL gets ?ref=mcp appended
 *   2. URL with existing query string preserves params + appends ref=mcp
 *   3. Idempotent: calling twice produces same result (D-10.2-09)
 *   4. Null / undefined / empty-string returns null (graceful for operators without website)
 *   5. Malformed URL throws TypeError (caller surfaces upstream_unavailable per D-10.2-10)
 */
import { describe, it, expect } from 'vitest'
import { decorateOperatorUrl } from '../url.js'

describe('decorateOperatorUrl', () => {
  it('appends ?ref=mcp to a bare URL', () => {
    const result = decorateOperatorUrl('https://example.com/')
    expect(result).toBe('https://example.com/?ref=mcp')
  })

  it('preserves existing query string when appending ref=mcp', () => {
    const result = decorateOperatorUrl('https://example.com/?utm_source=existing')
    expect(result).toBe('https://example.com/?utm_source=existing&ref=mcp')
  })

  it('is idempotent: calling twice produces the same URL (D-10.2-09)', () => {
    const once = decorateOperatorUrl('https://example.com/')
    const twice = decorateOperatorUrl(once)
    expect(twice).toBe(once)
    expect(twice).toBe('https://example.com/?ref=mcp')
  })

  it('returns null for null / undefined / empty-string input', () => {
    expect(decorateOperatorUrl(null)).toBeNull()
    expect(decorateOperatorUrl(undefined)).toBeNull()
    expect(decorateOperatorUrl('')).toBeNull()
  })

  it('throws TypeError on malformed URL (caller surfaces upstream_unavailable)', () => {
    // Inputs the URL constructor rejects; tool handler in get-operator.ts
    // catches the TypeError and returns the upstream_unavailable envelope
    // per D-10.2-10.
    expect(() => decorateOperatorUrl('not a real url')).toThrow(TypeError)
    expect(() => decorateOperatorUrl('http://')).toThrow(TypeError)
  })

  it('handles URLs without trailing slash correctly', () => {
    // Edge case: 'https://example.com' (no trailing /) normalizes to
    // 'https://example.com/?ref=mcp' via URL constructor's path defaulting.
    const result = decorateOperatorUrl('https://example.com')
    expect(result).toBe('https://example.com/?ref=mcp')
  })

  it('handles URLs with paths preserved', () => {
    const result = decorateOperatorUrl('https://example.com/about/team/')
    expect(result).toBe('https://example.com/about/team/?ref=mcp')
  })

  // Plan 10.4-05 Task 4 extension: Wave 10.4 token append per D-10.4-05.
  // valet_get_operator mints a 16-char URL-safe base64url token and passes
  // it to decorateOperatorUrl(url, token); when present, it is appended as
  // `&t=<token>` AFTER `?ref=mcp`. Skipped when undefined or empty string.
  it('appends &t=${token} when token arg is provided (D-10.4-05)', () => {
    const result = decorateOperatorUrl('https://op.example.com/', 'xK7q9Y2pL8nF4mZ3')
    expect(result).toBe('https://op.example.com/?ref=mcp&t=xK7q9Y2pL8nF4mZ3')
  })

  it('skips token append when token arg is undefined', () => {
    const result = decorateOperatorUrl('https://op.example.com/', undefined)
    expect(result).toBe('https://op.example.com/?ref=mcp')
    expect(result).not.toContain('&t=')
  })

  it('skips token append when token arg is empty string', () => {
    const result = decorateOperatorUrl('https://op.example.com/', '')
    expect(result).toBe('https://op.example.com/?ref=mcp')
    expect(result).not.toContain('&t=')
  })
})
