import { createHash } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthProof } from "./actions";
import type { OAuthFetch, OAuthTransaction } from "./oauth-flow";
import {
	exchangeCode,
	fetchUserInfo,
	registerTestClient,
	startAuthorization,
	submitConsent,
} from "./oauth-flow";

const origin = "http://localhost:3000";
const { getOpenIdConfig } = vi.hoisted(() => ({ getOpenIdConfig: vi.fn() }));

vi.mock("../../lib/auth", () => ({
	auth: { api: { getOpenIdConfig } },
}));

beforeEach(() => {
	getOpenIdConfig.mockResolvedValue({ issuer: origin });
});

async function setup(issuer = origin) {
	const { auth, signInWithTestUser, testUser } = await getTestInstance({
		baseURL: origin,
		rateLimit: { enabled: false },
		plugins: [
			jwt({ jwt: { issuer } }),
			oauthProvider({
				loginPage: "/sign-in",
				consentPage: "/oauth/consent",
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				selectAccount: {
					page: "/oauth/select-account",
					shouldRedirect: async () => true,
				},
			}),
		],
	});
	const { headers: sessionHeaders } = await signInWithTestUser();
	const session = await auth.api.getSession({ headers: sessionHeaders });
	getOpenIdConfig.mockResolvedValue(await auth.api.getOpenIdConfig());
	const request = vi.fn<OAuthFetch>(async (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("Origin", origin);
		if (init?.credentials !== "omit") {
			headers.set("Cookie", sessionHeaders.get("cookie") ?? "");
		}
		return auth.handler(
			new Request(new URL(String(input), origin), { ...init, headers }),
		);
	});
	const transaction: OAuthTransaction = {
		...(await createOAuthProof()),
		clientId: await registerTestClient(request),
		origin,
	};
	return {
		request,
		transaction,
		testUser: { ...testUser, id: session!.user.id },
	};
}

describe("client-test OAuth walkthrough", () => {
	it("creates fresh S256 PKCE, state, and nonce for each authorization", async () => {
		const first = await createOAuthProof();
		const second = await createOAuthProof();
		expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first.challenge).toBe(
			createHash("sha256").update(first.verifier).digest("base64url"),
		);
		for (const field of ["verifier", "state", "nonce"] as const) {
			expect(first[field]).not.toBe(second[field]);
		}
	});

	/**
	 * @see https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4
	 */
	it.each([true, false])(
		"uses the advertised issuer when a non-local HTTP issuer is normalized to HTTPS (accept: %s)",
		async (accept) => {
			const { request, transaction } = await setup(
				"http://auth.example.test:3000",
			);
			expect(transaction.issuer).toBe("https://auth.example.test:3000");
			const consent = await startAuthorization(transaction, request);
			if (consent.type !== "consent") throw new Error("Expected consent");
			const result = await submitConsent(
				transaction,
				consent.query,
				accept,
				request,
			);
			expect(result.type).toBe(accept ? "code" : "denied");
			if (result.type === "code") {
				const tokens = await exchangeCode(transaction, result.code, request);
				expect(
					await fetchUserInfo(tokens.access_token, request),
				).toHaveProperty("sub");
			}
		},
	);

	it("selects the active account, waits for consent, exchanges the code, and fetches UserInfo", async () => {
		const { request, transaction, testUser } = await setup();
		const consent = await startAuthorization(transaction, request);
		expect(consent.type).toBe("consent");
		expect(request.mock.calls.map(([path]) => String(path))).toContain(
			"/api/auth/oauth2/continue",
		);
		expect(
			request.mock.calls.some(([path]) =>
				String(path).includes("/oauth2/consent"),
			),
		).toBe(false);
		if (consent.type !== "consent") throw new Error("Expected consent");

		const result = await submitConsent(
			transaction,
			consent.query,
			true,
			request,
		);
		expect(result.type).toBe("code");
		if (result.type !== "code") throw new Error("Expected code");
		const tokens = await exchangeCode(transaction, result.code, request);
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();
		expect(tokens.id_token).toBeTruthy();
		expect(decodeJwt(tokens.id_token!).nonce).toBe(transaction.nonce);
		const userInfo = await fetchUserInfo(tokens.access_token, request);
		expect(userInfo).toMatchObject({
			sub: testUser.id,
			email: testUser.email,
			name: testUser.name,
		});
		expect(request.mock.calls.at(-1)?.[1]?.credentials).toBe("omit");
		await expect(
			exchangeCode(transaction, result.code, request),
		).rejects.toThrow();
	});

	it("handles denied consent without exchanging a code", async () => {
		const { request, transaction } = await setup();
		const consent = await startAuthorization(transaction, request);
		if (consent.type !== "consent") throw new Error("Expected consent");
		const result = await submitConsent(
			transaction,
			consent.query,
			false,
			request,
		);
		expect(result.type).toBe("denied");
		expect(
			request.mock.calls.some(([path]) =>
				String(path).includes("/oauth2/token"),
			),
		).toBe(false);
	});

	it.each([
		["state", "wrong-state"],
		["iss", "https://untrusted.example"],
		["code", ""],
	] as const)(
		"rejects a callback with an invalid %s",
		async (parameter, value) => {
			const { request, transaction } = await setup();
			const consent = await startAuthorization(transaction, request);
			if (consent.type !== "consent") throw new Error("Expected consent");
			const tampered: OAuthFetch = async (input, init) => {
				const response = await request(input, init);
				const body = (await response.json()) as {
					redirect: boolean;
					url: string;
				};
				const callback = new URL(body.url);
				callback.searchParams.set(parameter, value);
				return Response.json({ ...body, url: callback.href });
			};
			await expect(
				submitConsent(transaction, consent.query, true, tampered),
			).rejects.toThrow();
		},
	);

	it("rejects duplicate callback state and code parameters", async () => {
		const { transaction } = await setup();
		for (const parameter of ["state", "code"]) {
			const callback = new URL("http://127.0.0.1:8765/callback");
			callback.search = new URLSearchParams({
				state: transaction.state,
				iss: origin,
				code: "code",
			}).toString();
			callback.searchParams.append(parameter, "duplicate");
			const request: OAuthFetch = async () =>
				Response.json({ redirect: true, url: callback.href });
			await expect(startAuthorization(transaction, request)).rejects.toThrow();
		}
	});

	it("rejects unexpected redirect origins and stops selection loops", async () => {
		const { transaction } = await setup();
		const external: OAuthFetch = async () =>
			Response.json({
				redirect: true,
				url: "https://untrusted.example/oauth/consent",
			});
		await expect(startAuthorization(transaction, external)).rejects.toThrow(
			"origin",
		);
		const looping = vi.fn<OAuthFetch>(async () =>
			Response.json({
				redirect: true,
				url: "/oauth/select-account?sig=fixture",
			}),
		);
		await expect(startAuthorization(transaction, looping)).rejects.toThrow(
			"did not finish",
		);
		expect(looping).toHaveBeenCalledTimes(6);
	});

	it("reports token endpoint errors and rejects invalid UserInfo", async () => {
		const { transaction } = await setup();
		const rejected: OAuthFetch = async () =>
			Response.json(
				{ error: "invalid_grant", error_description: "The code has expired." },
				{ status: 400 },
			);
		await expect(
			exchangeCode(transaction, "expired", rejected),
		).rejects.toThrow("The code has expired.");
		const missingSubject: OAuthFetch = async () =>
			Response.json({ email: "test@example.com" });
		await expect(fetchUserInfo("token", missingSubject)).rejects.toThrow();
	});
});
