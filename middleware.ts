/**
 * middleware.ts
 *
 * HTTP Basic Auth gate for all pages and API routes.
 * Password is stored in the SITE_PASSWORD environment variable.
 *
 * To disable in development, leave SITE_PASSWORD unset — the middleware
 * will pass all requests through.
 */
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const sitePassword = process.env.SITE_PASSWORD;

  // If no password is configured (local dev), allow all requests through.
  if (!sitePassword) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const encoded = authHeader.split(' ')[1] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [, password] = decoded.split(':');

    if (password === sitePassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="N of 1 Precision Formulation"',
    },
  });
}

export const config = {
  // Protect all routes except Next.js internals, static assets, and the health check.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
