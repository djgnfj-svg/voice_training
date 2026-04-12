import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard', '/interview/', '/credits', '/history', '/resume', '/model-answer'],
      },
    ],
    sitemap: 'https://jachana.com/sitemap.xml',
  };
}
