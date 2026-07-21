import { config, type DemoUser } from './config.js';

/**
 * Resolves the demo user for this email. The password is intentionally not checked — every
 * demo user's password is the same hardcoded value, so verifying it adds no real security, and
 * the login form still asks for one purely to look like a real login flow.
 */
export function verifyCredentials(email: string): ({ email: string } & DemoUser) | null {
  const normalized = email.trim().toLowerCase();
  const user = config.users[normalized];
  if (!user) return null;
  return { email: normalized, ...user };
}
