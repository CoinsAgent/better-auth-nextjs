"use server";

import { auth } from "../../lib/auth";

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** Generate fresh OAuth proof on the server, including for HTTP demo browsers. */
export async function createOAuthProof() {
	// Metadata applies the provider's issuer normalization, including HTTPS for
	// non-loopback hosts. Keep the expected issuer independent of the callback.
	const { issuer } = await auth.api.getOpenIdConfig();
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return {
		verifier,
		challenge: base64url(new Uint8Array(digest)),
		state: base64url(crypto.getRandomValues(new Uint8Array(32))),
		nonce: base64url(crypto.getRandomValues(new Uint8Array(32))),
		issuer,
	};
}
