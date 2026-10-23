import { createHash } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { siweClient } from "better-auth/client/plugins";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { hexToString, isHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { describe, expect, it, vi } from "vitest";
import { createDemoSIWEPlugin } from "../../lib/siwe";
import type { OAuthFetch } from "./oauth-flow";
import {
	exchangeCode,
	fetchUserInfo,
	registerTestClient,
	startAuthorization,
	submitConsent,
} from "./oauth-flow";
import type { EthereumProvider } from "./siwe-login";
import { signInWithWallet } from "./siwe-login";

const origin = "http://localhost:3000";

async function setup() {
	const { auth, client, sessionSetter } = await getTestInstance(
		{
			baseURL: origin,
			rateLimit: { enabled: false },
			plugins: [
				createDemoSIWEPlugin(origin),
				jwt({ jwt: { issuer: origin } }),
				oauthProvider({
					loginPage: "/sign-in",
					consentPage: "/oauth/consent",
					allowDynamicClientRegistration: true,
					allowUnauthenticatedClientRegistration: true,
				}),
			],
		},
		{ disableTestUser: true, clientOptions: { plugins: [siweClient()] } },
	);
	const headers = new Headers();
	const account = privateKeyToAccount(generatePrivateKey());
	const request = vi.fn<EthereumProvider["request"]>(
		async ({ method, params }) => {
			if (method === "eth_requestAccounts") return [account.address];
			if (method === "eth_chainId") return "0x1";
			if (method === "personal_sign") {
				const raw = params?.[0];
				if (typeof raw !== "string" || !isHex(raw))
					throw new Error("Expected a hex message");
				expect(params?.[1]).toBe(account.address);
				return account.signMessage({ message: { raw } });
			}
			throw new Error(`Unexpected wallet request: ${method}`);
		},
	);
	const api = {
		nonce: () => client.siwe.nonce(),
		verify: (body: { message: string; signature: string }) =>
			client.siwe.verify(body, { onSuccess: sessionSetter(headers) }),
	};
	return { auth, client, headers, account, provider: { request }, api };
}

describe("SIWE client-test sign-in", () => {
	it("signs a real SIWE message without email and completes code, token, and UserInfo requests", async () => {
		const { auth, client, headers, account, provider, api } = await setup();
		const user = await signInWithWallet(provider, origin, api);
		expect(user.walletAddress).toBe(account.address);
		expect(user.chainId).toBe(1);
		const session = await auth.api.getSession({ headers });
		expect(session?.user.id).toBe(user.id);
		expect(session?.user.emailVerified).toBe(false);
		expect(session?.user.email).toBe(
			`${account.address.toLowerCase()}@siwe.placeholder.invalid`,
		);
		const accounts = await auth.api.listUserAccounts({ headers });
		expect(accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "siwe",
					accountId: `${account.address}:1`,
				}),
			]),
		);
		expect(provider.request.mock.calls.map(([args]) => args.method)).toEqual([
			"eth_requestAccounts",
			"eth_chainId",
			"personal_sign",
		]);
		const rawMessage = provider.request.mock.calls[2]?.[0].params?.[0];
		if (typeof rawMessage !== "string" || !isHex(rawMessage))
			throw new Error("Missing wallet message");
		const message = hexToString(rawMessage);
		expect(parseSiweMessage(message)).toMatchObject({
			address: account.address,
			domain: "localhost:3000",
			chainId: 1,
			uri: `${origin}/client-test-siwe`,
		});
		// The plugin consumes the nonce; the exact same signed message cannot replay.
		const replay = await client.siwe.verify({
			message,
			signature: await account.signMessage({ message }),
		});
		expect(replay.error?.status).toBe(401);

		const request: OAuthFetch = (path, init) => {
			const requestHeaders = new Headers(init?.headers);
			requestHeaders.set("Origin", origin);
			if (init?.credentials !== "omit")
				requestHeaders.set("Cookie", headers.get("cookie") ?? "");
			return auth.handler(
				new Request(new URL(path, origin), {
					...init,
					headers: requestHeaders,
				}),
			);
		};
		const verifier = "a".repeat(64);
		const transaction = {
			clientId: await registerTestClient(request),
			verifier,
			challenge: createHash("sha256").update(verifier).digest("base64url"),
			state: "siwe-client-test-state",
			nonce: "siwe-client-test-nonce",
			issuer: (await auth.api.getOpenIdConfig()).issuer,
			origin,
		};
		const consent = await startAuthorization(transaction, request);
		if (consent.type !== "consent") throw new Error("Expected consent");
		const callback = await submitConsent(
			transaction,
			consent.query,
			true,
			request,
		);
		if (callback.type !== "code")
			throw new Error("Expected authorization code");
		const tokens = await exchangeCode(transaction, callback.code, request);
		expect(tokens.refresh_token).toBeTruthy();
		expect(tokens.id_token).toBeTruthy();
		expect(await fetchUserInfo(tokens.access_token, request)).toMatchObject({
			sub: user.id,
			name: account.address,
		});
	});

	it("rejects a signature from a different wallet", async () => {
		const { headers, auth, provider, api } = await setup();
		const other = privateKeyToAccount(generatePrivateKey());
		const request: EthereumProvider["request"] = async (args) => {
			if (args.method !== "personal_sign") return provider.request(args);
			const raw = args.params?.[0];
			if (typeof raw !== "string" || !isHex(raw))
				throw new Error("Missing message");
			return other.signMessage({ message: { raw } });
		};
		await expect(signInWithWallet({ request }, origin, api)).rejects.toThrow();
		expect(await auth.api.getSession({ headers })).toBeNull();
	});

	it("rejects a signed message for another domain", async () => {
		const { provider, api } = await setup();
		await expect(
			signInWithWallet(provider, "https://other.example", api),
		).rejects.toThrow();
	});

	it("rejects a signed URI on another origin even when its domain matches", async () => {
		const { client, account } = await setup();
		const nonce = await client.siwe.nonce();
		const message = createSiweMessage({
			address: account.address,
			chainId: 1,
			domain: "localhost:3000",
			uri: "https://other.example/client-test-siwe",
			version: "1",
			nonce: nonce.data!.nonce,
		});
		const result = await client.siwe.verify({
			message,
			signature: await account.signMessage({ message }),
		});
		expect(result.error?.status).toBe(401);
	});

	it("does not authenticate when a wallet request is declined", async () => {
		const { api } = await setup();
		const verify = vi.spyOn(api, "verify");
		const request = vi
			.fn<EthereumProvider["request"]>()
			.mockRejectedValue({ code: 4001, message: "User rejected the request." });
		await expect(
			signInWithWallet({ request }, origin, api),
		).rejects.toMatchObject({ code: 4001 });
		expect(verify).not.toHaveBeenCalled();
	});

	it.each(["0x0", "not-a-chain"])(
		"rejects an invalid wallet chain %s",
		async (chain) => {
			const { provider, api } = await setup();
			const request: EthereumProvider["request"] = (args) =>
				args.method === "eth_chainId"
					? Promise.resolve(chain)
					: provider.request(args);
			await expect(
				signInWithWallet({ request }, origin, api),
			).rejects.toThrow();
			expect(
				provider.request.mock.calls.some(
					([args]) => args.method === "personal_sign",
				),
			).toBe(false);
		},
	);
});
