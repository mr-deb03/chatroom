/** @type {import('next').NextConfig} */
const nextConfig = {
  // Socket lifecycle is managed manually; avoid double-connect in dev.
  reactStrictMode: false,
};

module.exports = nextConfig;
