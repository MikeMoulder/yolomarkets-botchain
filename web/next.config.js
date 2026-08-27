/** @type {import('next').NextConfig} */
const nextConfig = {
    allowedDevOrigins: ["173.212.238.167"],
    serverExternalPackages: ["postgres", "drizzle-orm"],
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "polymarket-upload.s3.us-east-2.amazonaws.com",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "polymarket-upload.s3.amazonaws.com",
                pathname: "/**",
            },
        ],
    },
};

module.exports = nextConfig;
