import { config, type SinchCredentials } from './config.js';

/**
 * The "vault": resolves a verified subproject_id to its Sinch access key/secret.
 * Backed by the SINCH_CREDENTIALS env map for the demo; swap for a real secrets
 * manager without changing callers.
 */
export function getCredentials(subprojectId: string): SinchCredentials | null {
  return config.credentials[subprojectId] ?? null;
}
