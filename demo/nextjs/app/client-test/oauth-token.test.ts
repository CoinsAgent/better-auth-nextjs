import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./oauth-token.sh", import.meta.url));
const scopes = "openid profile email offline_access";
const redirectURI = "http://127.0.0.1:8765/callback";
const authorizationCode = "test-code+with/reserved=characters";
const sessionCookie = "oauth-test-session=private-test-session";
const selectionQuery = `scope=openid%20profile&sig=selection%2Bfixture%3D`;
const consentQuery = `scope=openid%20profile&sig=consent%2Bfixture%3D`;
const tokenResponse = {
	access_token: "test-access-token",
	refresh_token: "test-refresh-token",
	id_token: "test-id-token",
	token_type: "Bearer",
	expires_in: 3600,
};

interface RecordedRequest {
	method: string | undefined;
	path: string;
	query: URLSearchParams;
	headers: IncomingHttpHeaders;
	body: string;
}

interface ProviderOptions {
	flow?: "selection" | "consent" | "callback" | "loop";
	authorizationRedirect?: string;
	changeCallback?: (callback: URL) => void;
	responses?: Record<
		string,
		{ status?: number; body: unknown; contentType?: string }
	>;
}

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(closeServers.splice(0).map((close) => close()));
});

// This HTTP fixture tests the shell client's requests and failure handling.
// It does not implement OAuth validation or test Better Auth's server internals.
async function startProvider(options: ProviderOptions = {}) {
	const requests: RecordedRequest[] = [];
	let authorization: URL | undefined;
	let baseURL = "";
	const selectionURL = `/oauth/select-account?${selectionQuery}`;
	const consentURL = `/oauth/consent?${consentQuery}`;

	function callbackURL() {
		if (!authorization) throw new Error("Missing authorization request");
		const callback = new URL(redirectURI);
		callback.searchParams.set("code", authorizationCode);
		callback.searchParams.set(
			"state",
			authorization.searchParams.get("state") ?? "",
		);
		options.changeCallback?.(callback);
		return callback.href;
	}

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", baseURL);
			let body = "";
			request.setEncoding("utf8");
			for await (const chunk of request) body += String(chunk);
			requests.push({
				method: request.method,
				path: url.pathname,
				query: url.searchParams,
				headers: request.headers,
				body,
			});

			const override = options.responses?.[url.pathname];
			if (override) {
				response.statusCode = override.status ?? 200;
				response.setHeader(
					"Content-Type",
					override.contentType ?? "application/json",
				);
				response.end(
					override.contentType === "text/plain"
						? String(override.body)
						: JSON.stringify(override.body),
				);
				return;
			}

			response.setHeader("Content-Type", "application/json");
			let result: unknown;
			switch (url.pathname) {
				case "/api/auth/sign-up/email":
				case "/api/auth/sign-in/email": {
					const credentials = JSON.parse(body) as Record<string, unknown>;
					response.setHeader(
						"Set-Cookie",
						`${sessionCookie}; Path=/; HttpOnly`,
					);
					result = { user: { id: "test-user", email: credentials.email } };
					break;
				}
				case "/api/auth/oauth2/register":
					response.statusCode = 201;
					result = { client_id: "cli-test-client" };
					break;
				case "/api/auth/oauth2/authorize":
					authorization = url;
					result = {
						redirect: true,
						url:
							options.authorizationRedirect ??
							(options.flow === "callback"
								? callbackURL()
								: options.flow === "consent"
									? consentURL
									: selectionURL),
					};
					break;
				case "/api/auth/oauth2/continue":
					result = {
						redirect: true,
						url: options.flow === "loop" ? selectionURL : consentURL,
					};
					break;
				case "/api/auth/oauth2/consent":
					result = { redirect: true, url: callbackURL() };
					break;
				case "/api/auth/oauth2/token":
					result = tokenResponse;
					break;
				case "/api/auth/oauth2/userinfo":
					result = { sub: "test-user", email: "user@example.com" };
					break;
				default:
					response.statusCode = 404;
					result = { error: `Unexpected endpoint: ${url.pathname}` };
			}
			response.end(JSON.stringify(result));
		} catch (error) {
			response.statusCode = 500;
			response.end(JSON.stringify({ error: String(error) }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	closeServers.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test server address");
	baseURL = `http://127.0.0.1:${address.port}`;
	return { baseURL, requests };
}

function runScript(environment: Partial<NodeJS.ProcessEnv>) {
	return new Promise<{
		exitCode: number | string;
		killed: boolean;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		const child = execFile(
			"bash",
			[scriptPath],
			{
				env: {
					...process.env,
					OAUTH_EMAIL: "",
					OAUTH_PASSWORD: "",
					BASE_URL: "",
					BETTER_AUTH_URL: "",
					...environment,
				},
				timeout: 8_000,
			},
			(error, stdout, stderr) => {
				resolve({
					exitCode: error?.code ?? 0,
					killed: error?.killed ?? false,
					stdout,
					stderr,
				});
			},
		);
		// Closing stdin proves the entire flow completes without user input.
		child.stdin?.end();
	});
}

function findRequest(requests: RecordedRequest[], path: string) {
	const request = requests.find((item) => item.path === path);
	if (!request) throw new Error(`Expected request to ${path}`);
	return request;
}

describe("OAuth token shell script", () => {
	it.each(["selection", "consent", "callback"] as const)(
		"obtains tokens without stdin through the %s flow",
		async (flow) => {
			const { baseURL, requests } = await startProvider({ flow });
			const result = await runScript({ BASE_URL: baseURL });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.killed).toBe(false);
			const [tokens, userInfo] = result.stdout.split("UserInfo response:\n");
			expect(JSON.parse(tokens.replace("\nToken response:\n", ""))).toEqual(
				tokenResponse,
			);
			expect(JSON.parse(userInfo ?? "")).toEqual({
				sub: "test-user",
				email: "user@example.com",
			});
			expect(result.stderr).toContain("HTTP 201");
			expect(result.stderr).toContain(
				"Token type: Bearer; expires in: 3600 seconds",
			);
			expect(result.stderr).toContain(
				"OAuth/OIDC flow completed successfully.",
			);

			const signup = JSON.parse(
				findRequest(requests, "/api/auth/sign-up/email").body,
			) as Record<string, unknown>;
			expect(signup.email).toMatch(/^oauth-cli-.+@example\.com$/);
			expect(signup.password).toEqual(expect.any(String));
			const registration = JSON.parse(
				findRequest(requests, "/api/auth/oauth2/register").body,
			);
			expect(registration).toMatchObject({
				application_type: "native",
				token_endpoint_auth_method: "none",
				redirect_uris: [redirectURI],
				grant_types: ["authorization_code", "refresh_token"],
				scope: scopes,
			});
			const authorization = findRequest(requests, "/api/auth/oauth2/authorize");
			expect(authorization.method).toBe("GET");
			expect(authorization.query.get("client_id")).toBe("cli-test-client");
			expect(authorization.query.get("response_type")).toBe("code");
			expect(authorization.query.get("scope")).toBe(scopes);
			expect(authorization.query.get("code_challenge_method")).toBe("S256");
			expect(authorization.query.get("state")).toBeTruthy();
			expect(authorization.query.get("nonce")).toBeTruthy();

			for (const request of requests.filter(
				(item) =>
					![
						"/api/auth/sign-up/email",
						"/api/auth/oauth2/token",
						"/api/auth/oauth2/userinfo",
					].includes(item.path),
			)) {
				expect(request.headers.cookie).toContain(sessionCookie);
				expect(request.headers.origin).toBe(baseURL);
				expect(request.headers.accept).toBe("application/json");
			}
			if (flow === "selection") {
				expect(
					JSON.parse(findRequest(requests, "/api/auth/oauth2/continue").body),
				).toEqual({ selected: true, oauth_query: selectionQuery });
			}
			if (flow !== "callback") {
				expect(
					JSON.parse(findRequest(requests, "/api/auth/oauth2/consent").body),
				).toEqual({ accept: true, oauth_query: consentQuery });
			}
			const tokenRequest = findRequest(requests, "/api/auth/oauth2/token");
			expect(tokenRequest.headers["content-type"]).toBe(
				"application/x-www-form-urlencoded",
			);
			const form = new URLSearchParams(tokenRequest.body);
			expect(form.get("grant_type")).toBe("authorization_code");
			expect(form.get("client_id")).toBe("cli-test-client");
			expect(form.get("redirect_uri")).toBe(redirectURI);
			expect(form.get("code")).toBe(authorizationCode);
			const verifier = form.get("code_verifier") ?? "";
			expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
			expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
				authorization.query.get("code_challenge"),
			);
			expect(
				findRequest(requests, "/api/auth/oauth2/userinfo").headers
					.authorization,
			).toBe("Bearer test-access-token");
			for (const secret of [String(signup.password), sessionCookie, verifier]) {
				expect(result.stdout + result.stderr).not.toContain(secret);
			}
		},
	);

	it("signs in with environment credentials without creating another account", async () => {
		const { baseURL, requests } = await startProvider();
		const result = await runScript({
			BASE_URL: baseURL,
			OAUTH_EMAIL: "existing@example.com",
			OAUTH_PASSWORD: "test-password-do-not-log",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(
			JSON.parse(findRequest(requests, "/api/auth/sign-in/email").body),
		).toMatchObject({
			email: "existing@example.com",
			password: "test-password-do-not-log",
		});
		expect(
			requests.some((request) => request.path === "/api/auth/sign-up/email"),
		).toBe(false);
		expect(result.stdout + result.stderr).not.toContain(
			"test-password-do-not-log",
		);
	});

	it.each(["email", "password"])(
		"rejects a missing %s before making HTTP requests",
		async (missing) => {
			const { baseURL, requests } = await startProvider();
			const result = await runScript({
				BASE_URL: baseURL,
				OAUTH_EMAIL: missing === "email" ? "" : "existing@example.com",
				OAUTH_PASSWORD: missing === "password" ? "" : "test-password",
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(
				"Set both OAUTH_EMAIL and OAUTH_PASSWORD",
			);
			expect(requests).toHaveLength(0);
		},
	);

	it.each(["BASE_URL", "BETTER_AUTH_URL"])(
		"uses %s, including normalization of a trailing slash",
		async (variable) => {
			const { baseURL } = await startProvider({ flow: "callback" });
			const result = await runScript({
				[variable]: `${baseURL}/`,
				...(variable === "BASE_URL"
					? { BETTER_AUTH_URL: "http://invalid.example" }
					: {}),
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stderr).toContain(`Demo origin: ${baseURL}\n`);
		},
	);

	it("reports MFA sign-in without continuing to client registration", async () => {
		const { baseURL, requests } = await startProvider({
			responses: {
				"/api/auth/sign-in/email": { body: { twoFactorRedirect: true } },
			},
		});
		const result = await runScript({
			BASE_URL: baseURL,
			OAUTH_EMAIL: "existing@example.com",
			OAUTH_PASSWORD: "test-password",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Existing accounts requiring MFA");
		expect(requests.map((request) => request.path)).toEqual([
			"/api/auth/sign-in/email",
		]);
	});

	it.each([
		[
			"mismatched state",
			(url: URL) => url.searchParams.set("state", "wrong-state"),
			"Callback state does not match",
		],
		[
			"duplicate state",
			(url: URL) => url.searchParams.append("state", "second-state"),
			"Callback state does not match",
		],
		[
			"missing code",
			(url: URL) => url.searchParams.delete("code"),
			"Missing or duplicate authorization code",
		],
		[
			"duplicate code",
			(url: URL) => url.searchParams.append("code", "second-code"),
			"Missing or duplicate authorization code",
		],
		[
			"OAuth error",
			(url: URL) => {
				url.searchParams.set("error", "access_denied");
				url.searchParams.set("error_description", "Consent was denied");
			},
			"Consent was denied",
		],
	] as const)(
		"rejects a callback with %s before token exchange",
		async (_name, changeCallback, message) => {
			const { baseURL, requests } = await startProvider({ changeCallback });
			const result = await runScript({ BASE_URL: baseURL });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(message);
			expect(
				requests.some((request) => request.path === "/api/auth/oauth2/token"),
			).toBe(false);
		},
	);

	it.each([
		[
			"https://untrusted.example/oauth/consent",
			"Unexpected authorization redirect origin",
		],
		["/unsupported-step", "Unexpected authorization step: /unsupported-step"],
	])(
		"rejects the unsupported redirect %s",
		async (authorizationRedirect, message) => {
			const { baseURL, requests } = await startProvider({
				authorizationRedirect,
			});
			const result = await runScript({ BASE_URL: baseURL });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(message);
			expect(requests.at(-1)?.path).toBe("/api/auth/oauth2/authorize");
		},
	);

	it("stops authorization loops after five continuation requests", async () => {
		const { baseURL, requests } = await startProvider({ flow: "loop" });
		const result = await runScript({ BASE_URL: baseURL });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(
			"Authorization did not reach the callback within five steps",
		);
		expect(
			requests.filter(
				(request) => request.path === "/api/auth/oauth2/continue",
			),
		).toHaveLength(5);
	});

	it.each([
		["/api/auth/sign-up/email", 500, "Request failed; response body:"],
		["/api/auth/oauth2/register", 403, "Request failed; response body:"],
		["/api/auth/oauth2/token", 400, "Token exchange failed; response body:"],
		[
			"/api/auth/oauth2/userinfo",
			401,
			"UserInfo request failed; response body:",
		],
	] as const)(
		"reports %s failures with HTTP %i and stops the flow",
		async (path, status, message) => {
			const { baseURL, requests } = await startProvider({
				responses: {
					[path]: { status, body: { error: "test_endpoint_failure" } },
				},
			});
			const result = await runScript({ BASE_URL: baseURL });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(`HTTP ${status}`);
			expect(result.stderr).toContain(message);
			expect(result.stderr).toContain("test_endpoint_failure");
			expect(requests.at(-1)?.path).toBe(path);
		},
	);

	it.each([
		{ body: [], contentType: "application/json" },
		{ body: "not JSON", contentType: "text/plain" },
	])(
		"reports invalid JSON-object responses: $contentType",
		async (response) => {
			const { baseURL, requests } = await startProvider({
				responses: { "/api/auth/sign-up/email": response },
			});
			const result = await runScript({ BASE_URL: baseURL });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Expected a JSON object; response body:");
			expect(requests).toHaveLength(1);
		},
	);

	it("rejects a UserInfo response without a subject", async () => {
		const { baseURL } = await startProvider({
			responses: {
				"/api/auth/oauth2/userinfo": { body: { email: "user@example.com" } },
			},
		});
		const result = await runScript({ BASE_URL: baseURL });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("UserInfo is missing sub");
		expect(result.stderr).not.toContain(
			"OAuth/OIDC flow completed successfully.",
		);
	});
});
