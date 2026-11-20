import type { ExpressRequest, ExpressResponse, ExpressNext } from '../shared-types/index.ts';
import { isApiRequestPath } from '../auth.js';
import { isOriginAllowed, listWidgetInstallations } from './widget-installations.ts';

/**
 * @param origin
 */
export function isWidgetCorsOriginAllowed(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || !origin.trim()) return false;
  const normalizedOrigin = origin.trim();
  return listWidgetInstallations().some(
    (installation) => installation.enabled && isOriginAllowed(installation, normalizedOrigin),
  );
}

/**
 * @param req
 * @param res
 * @param origin
 */
export function applyWidgetCorsHeaders(req: ExpressRequest, res: ExpressResponse, origin: string | undefined) {
  const allowedOrigin = typeof origin === 'string' && origin.trim() ? origin.trim() : '';
  if (!allowedOrigin || !isWidgetCorsOriginAllowed(allowedOrigin)) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

/**
 * @param req
 * @param res
 * @param next
 */
export function handleWidgetCorsPreflight(req: ExpressRequest, res: ExpressResponse, next: ExpressNext) {
  if (req.method !== 'OPTIONS') return next();
  const reqPath = String(req.path || req.url || '').split('?')[0];
  if (!isApiRequestPath(reqPath)) return next();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (!isWidgetCorsOriginAllowed(origin)) return next();
  applyWidgetCorsHeaders(req, res, origin);
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.status(204).end();
}

/**
 * @param req
 * @param res
 * @param next
 */
export function applyWidgetCorsResponse(req: ExpressRequest, res: ExpressResponse, next: ExpressNext) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const widgetAccess = req.widgetAccess as { origin?: string } | undefined;
  if (widgetAccess?.origin) {
    applyWidgetCorsHeaders(req, res, widgetAccess.origin);
  } else if (origin) {
    applyWidgetCorsHeaders(req, res, origin);
  }
  next();
}
