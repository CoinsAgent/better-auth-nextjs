import * as z from "zod";

// Like oauth-token.sh, inspect the callback in memory without a loopback listener.
export const redirectURI = "http://127.0.0.1:8765/callback";
export const oauthScopes = [
	{
		name: "openid",
		description: "Identify your account and issue an ID token.",
	},
	{ name: "profile", description: "Read your name and profile picture." },
	{ name: "email", description: "Read your email address." },
	{
		name: "offline_access",
		description: "Keep access using a refresh token when you are away.",
	},
] as const;

const scope = oauthScopes.map((item) => item.name).join(" ");
const clientSchema = z.object({ client_id: z.string().min(1) });
const redirectSchema = z.object({ redirect: z.literal(true), url: z.string() });
const tokenSchema = z
	.object({
		access_token: z.string().min(1),
		token_type: z.string().regex(/^Bearer$/i),
		expires_in: z.number().positive(),
		refresh_token: z.string().optional(),
		id_token: z.string().optional(),
		scope: z.string().optional(),
	})
	.passthrough();
const userInfoSchema = z.object({ sub: z.string().min(1) }).passthrough();

export interface OAuthTransaction {
	clientId: string;
	verifier: string;
	challenge: string;
	state: string;
	nonce: string;
	issuer: string;
	origin: string;
}

export type OAuthStep =
	| { type: "consent"; query: string }
	| { type: "code"; code: string; callbackURL: string }
	| { type: "denied"; message: string };
export type OAuthTokens = z.infer<typeof tokenSchema>;
export type OAuthUserInfo = z.infer<typeof userInfoSchema>;
export type OAuthFetch = (
	path: string,
	init?: RequestInit,
) => Promise<Response>;

async function requestJSON(
	request: OAuthFetch,
	path: string,
	init: RequestInit = {},
) {
	const headers = new Headers(init.headers);
	headers.set("Accept", "application/json");
	const response = await request(path, {
		...init,
		headers,
		credentials: init.credentials ?? "same-origin",
		cache: "no-store",
		redirect: "error",
	});
	const body: unknown = await response.json();
	if (!response.ok) {
		const error = z
			.object({
				error_description: z.string().optional(),
				message: z.string().optional(),
				error: z.string().optional(),
			})
			.safeParse(body);
		throw new Error(
			(error.success &&
				(error.data.error_description ||
					error.data.message ||
					error.data.error)) ||
				`Request failed (HTTP ${response.status}).`,
		);
	}
	return body;
}

function jsonBody(body: Record<string, unknown>): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

/** Register a public test client; no client secret is sent to the browser. */
export async function registerTestClient(request: OAuthFetch = fetch) {
	return clientSchema.parse(
		await requestJSON(
			request,
			"/api/auth/oauth2/register",
			jsonBody({
				client_name: "Client Test Playground",
				application_type: "native",
				redirect_uris: [redirectURI],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				scope,
			}),
		),
	).client_id;
}

async function resolveAuthorization(
	body: unknown,
	transaction: OAuthTransaction,
	request: OAuthFetch,
): Promise<OAuthStep> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const redirect = redirectSchema.parse(body);
		const url = new URL(redirect.url, transaction.origin);
		const callback = new URL(redirectURI);
		if (url.origin === callback.origin && url.pathname === callback.pathname) {
			const params = url.searchParams;
			if (
				params.getAll("state").length !== 1 ||
				params.get("state") !== transaction.state
			) {
				throw new Error(
					"Callback state does not match. Start authorization again.",
				);
			}
			if (
				params.getAll("iss").length !== 1 ||
				params.get("iss") !== transaction.issuer
			) {
				throw new Error("Unexpected authorization server issuer.");
			}
			if (params.has("error")) {
				const message = params.get("error_description") || params.get("error")!;
				if (params.get("error") === "access_denied") {
					return { type: "denied", message };
				}
				throw new Error(message);
			}
			const codes = params.getAll("code");
			if (codes.length !== 1 || !codes[0]) {
				throw new Error("Missing or duplicate authorization code.");
			}
			return { type: "code", code: codes[0], callbackURL: url.href };
		}
		if (url.origin !== transaction.origin) {
			throw new Error("Unexpected authorization redirect origin.");
		}
		// Keep the exact signed query issued by the provider for each continuation.
		const query = url.search.slice(1);
		if (url.pathname === "/oauth/consent") {
			return { type: "consent", query };
		}
		if (url.pathname !== "/oauth/select-account") {
			throw new Error(`Unexpected authorization step: ${url.pathname}`);
		}
		body = await requestJSON(
			request,
			"/api/auth/oauth2/continue",
			jsonBody({ selected: true, oauth_query: query }),
		);
	}
	throw new Error("Authorization did not finish. Start authorization again.");
}

/** Start code + S256 PKCE authorization using the currently active account. */
export async function startAuthorization(
	transaction: OAuthTransaction,
	request: OAuthFetch = fetch,
) {
	const query = new URLSearchParams({
		client_id: transaction.clientId,
		redirect_uri: redirectURI,
		response_type: "code",
		scope,
		state: transaction.state,
		nonce: transaction.nonce,
		code_challenge: transaction.challenge,
		code_challenge_method: "S256",
		prompt: "consent",
	});
	return resolveAuthorization(
		await requestJSON(request, `/api/auth/oauth2/authorize?${query}`),
		transaction,
		request,
	);
}

/** Submit the user's explicit consent decision and validate the callback. */
export async function submitConsent(
	transaction: OAuthTransaction,
	query: string,
	accept: boolean,
	request: OAuthFetch = fetch,
) {
	return resolveAuthorization(
		await requestJSON(
			request,
			"/api/auth/oauth2/consent",
			jsonBody({ accept, oauth_query: query }),
		),
		transaction,
		request,
	);
}

/** Exchange a single-use authorization code with its original PKCE verifier. */
export async function exchangeCode(
	transaction: OAuthTransaction,
	code: string,
	request: OAuthFetch = fetch,
) {
	return tokenSchema.parse(
		await requestJSON(request, "/api/auth/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: transaction.clientId,
				redirect_uri: redirectURI,
				code,
				code_verifier: transaction.verifier,
			}),
		}),
	);
}

/** Fetch OIDC UserInfo using the access token, independently of session cookies. */
export async function fetchUserInfo(
	accessToken: string,
	request: OAuthFetch = fetch,
) {
	return userInfoSchema.parse(
		await requestJSON(request, "/api/auth/oauth2/userinfo", {
			headers: { Authorization: `Bearer ${accessToken}` },
			credentials: "omit",
		}),
	);
}
