import { getAddress, stringToHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import * as z from "zod";

export interface EthereumProvider {
	request: (args: {
		method: string;
		params?: readonly unknown[];
	}) => Promise<unknown>;
}

interface SIWEClient {
	nonce: () => Promise<{
		data?: { nonce: string } | null;
		error?: { message?: string } | null;
	}>;
	verify: (body: { message: string; signature: string }) => Promise<{
		data?: unknown;
		error?: { message?: string } | null;
	}>;
}

/** Connect an injected wallet, sign an expiring SIWE message, and create a session. */
export async function signInWithWallet(
	provider: EthereumProvider,
	origin: string,
	client: SIWEClient,
	onMessage?: (message: string) => void,
) {
	const accounts = z
		.array(z.string())
		.min(1)
		.parse(await provider.request({ method: "eth_requestAccounts" }));
	const address = getAddress(accounts[0]!);
	const chain = z
		.string()
		.regex(/^0x[\da-f]+$/i)
		.parse(await provider.request({ method: "eth_chainId" }));
	const chainId = Number.parseInt(chain, 16);
	if (!Number.isSafeInteger(chainId) || chainId <= 0) {
		throw new Error("The wallet returned an invalid chain ID.");
	}
	const nonce = await client.nonce();
	if (nonce.error || !nonce.data?.nonce) {
		throw new Error(
			nonce.error?.message || "Could not request a sign-in nonce.",
		);
	}
	const message = createSiweMessage({
		address,
		chainId,
		domain: new URL(origin).host,
		uri: new URL("/client-test-siwe", origin).href,
		version: "1",
		nonce: nonce.data.nonce,
		statement: "Sign in to the Better Auth SIWE client test.",
		issuedAt: new Date(),
		expirationTime: new Date(Date.now() + 5 * 60 * 1000),
	});
	onMessage?.(message);
	const signature = z
		.string()
		.min(1)
		.parse(
			await provider.request({
				method: "personal_sign",
				params: [stringToHex(message), address],
			}),
		);
	const verification = await client.verify({ message, signature });
	if (verification.error) {
		throw new Error(verification.error?.message || "Wallet sign-in failed.");
	}
	return z
		.object({
			success: z.literal(true),
			user: z.object({
				id: z.string().min(1),
				walletAddress: z.string().regex(/^0x[\da-f]{40}$/i),
				chainId: z.number().int().positive(),
			}),
		})
		.parse(verification.data).user;
}
