import bcrypt from 'bcryptjs';
import { config, type DemoUser } from './config.js';

/**
 * Verifies a user's credentials against the configured USERS map and returns the
 * matching demo user (which carries the subprojectId) on success, or null.
 *
 * Always runs a bcrypt comparison (even for unknown emails, against a dummy hash)
 * to avoid leaking which emails exist via response timing.
 */

// A valid bcrypt hash of a random string, used to keep timing uniform for unknown emails.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DA0WqXr6r4t8x6m3J0nqVQ6Yp9bS';

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<({ email: string } & DemoUser) | null> {
  const normalized = email.trim().toLowerCase();
  const user = config.users[normalized];
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!ok || !user) return null;
  return { email: normalized, ...user };
}
