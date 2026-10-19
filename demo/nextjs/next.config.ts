import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	allowedDevOrigins: ["170.106.176.163"],
	typescript: {
		ignoreBuildErrors: true,
	},
	serverExternalPackages: ["libsql"],
};

export default nextConfig;
