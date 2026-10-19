import { sendEmail } from "@better-auth/infra";
import type { BetterAuthOptions } from "better-auth";
import { getTestInstance } from "better-auth/test";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("@better-auth/infra", async (importOriginal) => ({
	...(await importOriginal<typeof import("@better-auth/infra")>()),
	sendEmail: vi.fn(),
}));

let demoOptions: BetterAuthOptions;

beforeAll(async () => {
	vi.stubEnv("DEMO_SQLITE_PATH", ":memory:");
	vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
	vi.stubEnv("SCIM_DEMO_ENABLED", "false");
	const { auth } = await import("./auth");
	demoOptions = auth.options;
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterAll(() => {
	vi.unstubAllEnvs();
});

function createSignupTest() {
	return getTestInstance(
		{
			emailAndPassword: demoOptions.emailAndPassword,
			emailVerification: demoOptions.emailVerification,
		},
		{ disableTestUser: true },
	);
}

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
		expect(sendEmail).not.toHaveBeenCalled();
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
		expect(sendEmail).not.toHaveBeenCalled();
	});
});
