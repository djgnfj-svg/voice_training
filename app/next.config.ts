import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['msedge-tts'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'minio',
        port: '9000',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
    ],
  },
};

export default nextConfig;
