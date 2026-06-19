/**
 * In-memory store for Device Authorization Grant (RFC 8628).
 * For production, back with Redis or a shared database.
 */

const DEVICE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type DeviceStatus = 'pending' | 'authorized' | 'denied';

export interface DeviceRecord {
  userCode: string;
  clientId: string;
  scope: string;
  status: DeviceStatus;
  subprojectId?: string;
  email?: string;
  expiresAt: number;
}

const deviceCodes = new Map<string, DeviceRecord>(); // deviceCode → record
const userCodes = new Map<string, string>();          // userCode   → deviceCode

/** Generates a short, human-friendly code like "SINCH-A7K3". */
export function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = () => chars[Math.floor(Math.random() * chars.length)];
  return `SINCH-${rnd()}${rnd()}${rnd()}${rnd()}`;
}

export function storeDeviceCode(
  deviceCode: string,
  record: Omit<DeviceRecord, 'expiresAt'>,
): void {
  const full: DeviceRecord = { ...record, expiresAt: Date.now() + DEVICE_TTL_MS };
  deviceCodes.set(deviceCode, full);
  userCodes.set(record.userCode, deviceCode);
}

export function getByUserCode(userCode: string): DeviceRecord | null {
  const dc = userCodes.get(userCode.trim().toUpperCase());
  if (!dc) return null;
  const record = deviceCodes.get(dc);
  if (!record || Date.now() > record.expiresAt) return null;
  return record;
}

/** Marks a device code as authorized by the user. */
export function authorizeDevice(
  userCode: string,
  email: string,
  subprojectId: string,
): boolean {
  const dc = userCodes.get(userCode.trim().toUpperCase());
  if (!dc) return false;
  const record = deviceCodes.get(dc);
  if (!record || Date.now() > record.expiresAt) return false;
  record.status = 'authorized';
  record.email = email;
  record.subprojectId = subprojectId;
  return true;
}

/**
 * Polls a device code — returns the record if authorized (and removes it),
 * null if still pending, throws if expired/unknown.
 */
export function pollDeviceToken(deviceCode: string): DeviceRecord | null | 'expired' {
  const record = deviceCodes.get(deviceCode);
  if (!record) return 'expired';
  if (Date.now() > record.expiresAt) {
    userCodes.delete(record.userCode);
    deviceCodes.delete(deviceCode);
    return 'expired';
  }
  if (record.status !== 'authorized') return null; // still pending
  // Consume: single-use
  userCodes.delete(record.userCode);
  deviceCodes.delete(deviceCode);
  return record;
}

// Periodically clean up expired records.
setInterval(() => {
  const now = Date.now();
  for (const [code, record] of deviceCodes) {
    if (now > record.expiresAt) {
      userCodes.delete(record.userCode);
      deviceCodes.delete(code);
    }
  }
}, 60_000).unref();
