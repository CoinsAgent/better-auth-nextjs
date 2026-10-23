import { siwe } from "better-auth/plugins";
import { getAddress, isHex, verifyMessage } from "viem";
import { parseSiweMessage } from "viem/siwe";

/** Configure wallet sign-in for the demo's public origin without RPC requests. */
export function createDemoSIWEPlugin(publicURL: string) {
	const origin = new URL(publicURL).origin;
	return siwe({
		domain: new URL(origin).host,
		anonymous: true,
		async getNonce() {
			return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		},
		async verifyMessage({ address, message, signature }) {
			try {
				const { uri } = parseSiweMessage(message);
				if (
					!uri ||
					new URL(uri).origin !== origin ||
					!isHex(signature, { strict: true })
				) {
					return false;
				}
				return await verifyMessage({
					address: getAddress(address),
					message,
					signature,
				});
			} catch {
				return false;
			}
		},
	});
}
