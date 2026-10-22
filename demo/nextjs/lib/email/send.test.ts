import { afterEach, describe, expect, it, vi } from "vitest";
import { sendDemoEmail } from "./send.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("demo email preview", () => {
	it.each(["development", "test"])(
		"previews emails locally in %s without making network requests",
		async (environment) => {
			vi.stubEnv("NODE_ENV", environment);
			const output = vi.spyOn(console, "info").mockImplementation(() => {});
			const network = vi.spyOn(globalThis, "fetch");
			const message = {
				to: "user@example.com",
				subject: "Reset your password",
				text: "Reset your password: http://localhost:3000/reset-password/test",
			};

			await sendDemoEmail(message);

			expect(output).toHaveBeenCalledWith("[Demo email preview]", message);
			expect(network).not.toHaveBeenCalled();
		},
	);

	it("requires an email sender in production without logging email contents", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const output = vi.spyOn(console, "info").mockImplementation(() => {});
		const network = vi.spyOn(globalThis, "fetch");

		await expect(
			sendDemoEmail({
				to: "user@example.com",
				subject: "Your two-factor authentication code",
				text: "Your authentication code is: 123456",
			}),
		).rejects.toThrow("Email delivery is not configured");

		expect(output).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
	});
});
