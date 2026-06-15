/**
 * Produces a bcrypt hash for a demo user's password, for use in the USERS env map.
 * Run:  npx tsx scripts/hash-password.ts 'the-password'
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error("usage: npx tsx scripts/hash-password.ts '<password>'");
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log(hash);
