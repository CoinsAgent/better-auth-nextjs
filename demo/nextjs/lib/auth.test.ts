import type { BetterAuthOptions } from "better-auth";
import { getTestInstance } from "better-auth/test";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { sendDemoEmail } from "./email/send.ts";

vi.mock("./email/send.ts", () => ({
	sendDemoEmail: vi.fn(),
}));

let demoOptions: BetterAuthOptions;

beforeAll(async () => {
	vi.stubEnv("DEMO_SQLITE_PATH", ":memory:");
	vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
	vi.stubEnv("SCIM_DEMO_ENABLED", "false");
	vi.stubEnv("BETTER_AUTH_API_KEY", "");
	const { auth } = await import("./auth");
	demoOptions = auth.options;
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	vi.unstubAllEnvs();
});

function createSignupTest() {
	return getTestInstance(
		{
			account: demoOptions.account,
			emailAndPassword: demoOptions.emailAndPassword,
			emailVerification: demoOptions.emailVerification,
			socialProviders: demoOptions.socialProviders,
		},
		{ disableTestUser: true },
	);
}

describe("demo authentication without hosted Infrastructure", () => {
	it("signs up, signs in, and requests a password reset without external requests", async () => {
		const network = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected external request"));
		const { database: _database, ...options } = demoOptions;
		const { auth, client } = await getTestInstance(
			{ ...options, socialProviders: demoOptions.socialProviders },
			{ disableTestUser: true },
		);
		const credentials = {
			email: "local-auth@example.com",
			password: "local-auth-test-password",
		};

		const signup = await client.signUp.email({
			...credentials,
			name: "Local Auth User",
		});
		expect(signup.error).toBeNull();
		expect(signup.data?.token).toBeTruthy();

		const signin = await client.signIn.email(credentials);
		expect(signin.error).toBeNull();
		expect(signin.data?.token).toBeTruthy();

		const reset = await client.requestPasswordReset({
			email: credentials.email,
			redirectTo: "/reset-password",
		});
		expect(reset.error).toBeNull();
		expect(sendDemoEmail).toHaveBeenCalledWith({
			to: credentials.email,
			subject: "Reset your password",
			text: expect.stringContaining(
				"http://localhost:3000/api/auth/reset-password/",
			),
		});

		const dashboard = await auth.handler(
			new Request("http://localhost:3000/api/auth/dash/users"),
		);
		expect(dashboard.status).toBe(404);
		expect(network).not.toHaveBeenCalled();
	});
});

describe("demo social sign-in", () => {
	it.each([
		"facebook",
		"github",
		"google",
		"discord",
		"microsoft",
		"twitch",
		"twitter",
		"paypal",
		"vercel",
	] as const)("rejects sign-in with %s", async (provider) => {
		const { client } = await createSignupTest();

		const result = await client.signIn.social({
			provider,
			callbackURL: "http://localhost:3000/dashboard",
		});

		expect(result.error?.status).toBe(404);
		expect(result.error?.code).toBe("PROVIDER_NOT_FOUND");
		expect(result.data).toBeNull();
	});
});

/**
 * @see https://www.better-auth.com/docs/authentication/email-password#email-verification
 */
describe("demo signup without email verification", () => {
	it("creates a session and allows sign-in while the email remains unverified", async () => {
		const { auth, client, sessionSetter } = await createSignupTest();
		const headers = new Headers();
		const credentials = {
			email: "signup@example.com",
			password: "signup-test-password",
		};
		const signup = await client.signUp.email(
			{ ...credentials, name: "Signup User" },
			{ onSuccess: sessionSetter(headers) },
		);

		expect(signup.error).toBeNull();
		expect(signup.data?.token).toBeTruthy();
		expect(signup.data?.user.emailVerified).toBe(false);
		const session = await auth.api.getSession({ headers });
		expect(session?.user.email).toBe(credentials.email);

		const signin = await client.signIn.email(credentials);
		expect(signin.error).toBeNull();
		expect(signin.data?.token).toBeTruthy();
		expect(sendDemoEmail).not.toHaveBeenCalled();
	});

	it("does not allow verification emails to be sent for a new account", async () => {
		const { client } = await createSignupTest();
		const email = "no-verification@example.com";
		const signup = await client.signUp.email({
			email,
			password: "signup-test-password",
			name: "Signup User",
		});
		expect(signup.error).toBeNull();

		const verification = await client.sendVerificationEmail({ email });

		expect(verification.error?.status).toBe(400);
		expect(sendDemoEmail).not.toHaveBeenCalled();
	});
});
