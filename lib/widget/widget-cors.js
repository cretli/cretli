import { isOriginAllowed, listWidgetInstallations } from './widget-installations.js';

/**
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function isWidgetCorsOriginAllowed(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return false;
  const normalizedOrigin = origin.trim();
  return listWidgetInstallations().some(
    (installation) => installation.enabled && isOriginAllowed(installation, normalizedOrigin),
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string | undefined} origin
 */
export function applyWidgetCorsHeaders(req, res, origin) {
  const allowedOrigin = typeof origin === 'string' && origin.trim() ? origin.trim() : '';
  if (!allowedOrigin || !isWidgetCorsOriginAllowed(allowedOrigin)) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function handleWidgetCorsPreflight(req, res, next) {
  if (req.method !== 'OPTIONS') return next();
  const reqPath = String(req.path || req.url || '').split('?')[0];
  if (!reqPath.startsWith('/api/')) return next();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (!isWidgetCorsOriginAllowed(origin)) return next();
  applyWidgetCorsHeaders(req, res, origin);
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.status(204).end();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function applyWidgetCorsResponse(req, res, next) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (req.widgetAccess?.origin) {
    applyWidgetCorsHeaders(req, res, req.widgetAccess.origin);
  } else if (origin) {
    applyWidgetCorsHeaders(req, res, origin);
  }
  next();
}
