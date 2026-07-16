import type { Request, Response, NextFunction } from 'express';
import { config, type SinchCredentials } from './config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      subprojectId?: string;
      userEmail?: string;
      sinchCreds?: SinchCredentials;
    }
  }
}

/**
 * Single-tenant static authentication middleware.
 * Bypasses JWT and token validation, immediately binding the request
 * to the configured single-tenant project and credentials.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.subprojectId = config.projectId;
  req.sinchCreds = {
    accessKey: config.accessKey,
    accessSecret: config.accessSecret,
  };
  req.userEmail = 'single_tenant_user@sinch.com';
  next();
}
