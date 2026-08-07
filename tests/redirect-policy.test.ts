/**
 * The redirect policy is the security boundary that dynamic client
 * registration does not provide.
 *
 * `/register` is open and unauthenticated, because MCP clients require it to
 * be, so a client_id proves nothing about who is asking. The step that actually
 * converts a successful sign-in into someone else's access is where the
 * authorization code gets delivered. These tests are what stands between a
 * phishing link and a phoneware.us person's Autotask session.
 */

import { describe, it, expect } from 'vitest';
import {
  isAllowedRedirectUri,
  isPlausibleClientId,
  DEFAULT_REDIRECT_ALLOWLIST,
} from '../src/auth/redirect-policy.js';

describe('isAllowedRedirectUri', () => {
  it('allows loopback on any port, which is how native clients work', () => {
    // The port is assigned per sign-in attempt, so it cannot be pinned.
    for (const uri of [
      'http://localhost:3118/callback',
      'http://localhost:56069/callback',
      'http://127.0.0.1:51000/callback',
      'https://localhost:8443/callback',
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    }
  });

  it('allows the hosted connector callback', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback/')).toBe(true);
  });

  it('refuses anywhere else, which is the phishing shape', () => {
    for (const uri of [
      'https://evil.example/steal',
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      'https://evil.example/api/mcp/auth_callback',
      'http://evil.example/steal',
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    }
  });

  it('refuses a lookalike that only shares a path or a prefix', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback/../../evil')).toBe(false);
    expect(isAllowedRedirectUri('https://claude.ai/evil')).toBe(false);
    expect(isAllowedRedirectUri('https://notclaude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('refuses a host that merely contains localhost', () => {
    expect(isAllowedRedirectUri('https://localhost.evil.example/callback')).toBe(false);
    expect(isAllowedRedirectUri('https://mylocalhost/callback')).toBe(false);
  });

  it('refuses plaintext off-machine even to an allowlisted host', () => {
    expect(isAllowedRedirectUri('http://claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('refuses a redirect carrying embedded credentials', () => {
    // userinfo is a classic way to make a hostile URL read as a friendly one.
    expect(isAllowedRedirectUri('https://claude.ai@evil.example/api/mcp/auth_callback')).toBe(
      false,
    );
    expect(isAllowedRedirectUri('http://user:pass@localhost:3118/callback')).toBe(false);
  });

  it('refuses non-http schemes', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://evil.example/x',
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    }
  });

  it('refuses anything unparseable', () => {
    for (const uri of ['', 'not a url', '///', 'https://']) {
      expect(isAllowedRedirectUri(uri)).toBe(false);
    }
  });

  it('honours a configured allowlist in place of the default', () => {
    const custom = ['https://mcp.example.com/cb'];
    expect(isAllowedRedirectUri('https://mcp.example.com/cb', custom)).toBe(true);
    // Replacing the default means the default is no longer implied.
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', custom)).toBe(false);
    // Loopback is unconditional, so a CLI client still works.
    expect(isAllowedRedirectUri('http://localhost:3118/callback', custom)).toBe(true);
  });

  it('has a default that is exactly the hosted connector, nothing wider', () => {
    expect(DEFAULT_REDIRECT_ALLOWLIST).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });
});

describe('isPlausibleClientId', () => {
  it('accepts the ids we issue', () => {
    expect(isPlausibleClientId('c13c9bc3-2d84-469e-9ad0-165457c895ea')).toBe(true);
    expect(isPlausibleClientId('885fd948-40a7-469f-8ed7-79937f74f9fd')).toBe(true);
  });

  it('rejects anything that would be unsafe as a document key or a log line', () => {
    for (const id of [
      '',
      'short',
      'has/slash/segments',
      '../../escape',
      '<img src=x>',
      'has space',
      'x'.repeat(129),
    ]) {
      expect(isPlausibleClientId(id)).toBe(false);
    }
  });
});
