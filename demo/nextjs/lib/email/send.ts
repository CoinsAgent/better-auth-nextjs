interface DemoEmail {
	to: string;
	subject: string;
	text: string;
}

/** Preview demo emails locally without contacting an email delivery service. */
export async function sendDemoEmail(message: DemoEmail): Promise<void> {
	if (
		process.env.NODE_ENV !== "development" &&
		process.env.NODE_ENV !== "test"
	) {
		throw new Error(
			"Email delivery is not configured. Configure an email sender in lib/email/send.ts for production.",
		);
	}

	console.info("[Demo email preview]", message);
}
