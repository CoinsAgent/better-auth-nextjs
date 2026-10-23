"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createOAuthProof } from "./actions";
import type {
	OAuthStep,
	OAuthTokens,
	OAuthTransaction,
	OAuthUserInfo,
} from "./oauth-flow";
import {
	exchangeCode,
	fetchUserInfo,
	oauthScopes,
	registerTestClient,
	startAuthorization,
	submitConsent,
} from "./oauth-flow";

function JsonResult({ value }: { value: unknown }) {
	return (
		<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-4 text-xs">
			{JSON.stringify(value, null, 2)}
		</pre>
	);
}

/** Inspect each OAuth step without navigating away from the test page. */
export function OAuthPlayground({
	user,
}: {
	user?: { name: string; email: string };
}) {
	const [clientId, setClientId] = useState<string>();
	const [transaction, setTransaction] = useState<OAuthTransaction>();
	const [step, setStep] = useState<OAuthStep>();
	const [tokens, setTokens] = useState<OAuthTokens>();
	const [userInfo, setUserInfo] = useState<OAuthUserInfo>();
	const [exchangeAttempted, setExchangeAttempted] = useState(false);
	const [pending, setPending] = useState<string>();
	const [error, setError] = useState<string>();
	const busy = pending !== undefined;

	async function run(label: string, operation: () => Promise<void>) {
		setPending(label);
		setError(undefined);
		try {
			await operation();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The request failed.");
		} finally {
			setPending(undefined);
		}
	}

	function begin() {
		void run("Starting authorization…", async () => {
			setStep(undefined);
			setTokens(undefined);
			setUserInfo(undefined);
			setTransaction(undefined);
			setExchangeAttempted(false);
			const proof = await createOAuthProof();
			const id = clientId ?? (await registerTestClient());
			setClientId(id);
			const nextTransaction = {
				...proof,
				clientId: id,
				origin: window.location.origin,
			};
			setTransaction(nextTransaction);
			setStep(await startAuthorization(nextTransaction));
		});
	}

	function consent(accept: boolean) {
		if (!transaction || step?.type !== "consent") return;
		void run(accept ? "Authorizing…" : "Declining…", async () => {
			setStep(await submitConsent(transaction, step.query, accept));
		});
	}

	const consentStatus =
		step?.type === "denied"
			? "Access denied. No code or tokens were issued."
			: step?.type === "code"
				? "Access approved. Authorization code received."
				: step?.type === "consent"
					? "Review the permissions below, then allow or deny access."
					: "Start authorization to review the consent request.";

	return (
		<section className="space-y-6" aria-label="OAuth authorization code flow">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold">
						OAuth authorization code flow
					</h2>
					<p className="text-sm text-muted-foreground">
						Consent → Code → Token → User info. Results stay on this page until
						you restart, sign out, or reload.
					</p>
				</div>
				<Button onClick={begin} disabled={!user || busy}>
					{busy && <Loader2 size={16} className="mr-2 animate-spin" />}
					{step ? "Restart authorization" : "Start authorization"}
				</Button>
			</div>
			{!user && (
				<p className="text-sm text-muted-foreground">
					Sign in above to start the OAuth flow.
				</p>
			)}
			<div role="status" aria-live="polite" className="text-sm">
				{pending}
			</div>
			{error && (
				<p
					role="alert"
					className="rounded-md bg-destructive/10 p-4 text-sm text-destructive"
				>
					{error}
				</p>
			)}
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>3. Consent</CardTitle>
						<CardDescription>{consentStatus}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="font-medium">Client Test Playground</p>
						{user && <p className="text-sm">Authorizing as {user.email}</p>}
						<ul className="space-y-3">
							{oauthScopes.map((item) => (
								<li key={item.name} className="text-sm">
									<span className="font-medium">{item.name}</span>
									<p className="text-muted-foreground">{item.description}</p>
								</li>
							))}
						</ul>
						{clientId && (
							<p className="break-all text-xs text-muted-foreground">
								Client ID: {clientId}
							</p>
						)}
						{step?.type === "denied" && (
							<p className="text-sm">{step.message}</p>
						)}
					</CardContent>
					<CardFooter className="gap-3">
						<Button
							disabled={busy || step?.type !== "consent"}
							onClick={() => consent(true)}
						>
							Allow access
						</Button>
						<Button
							variant="outline"
							disabled={busy || step?.type !== "consent"}
							onClick={() => consent(false)}
						>
							Deny
						</Button>
					</CardFooter>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>4. Authorization code</CardTitle>
						<CardDescription>
							Approve consent to receive a short-lived, single-use code.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						{step?.type === "code" ? (
							<>
								<p className="text-sm">
									Callback state and issuer verified. PKCE: S256.
								</p>
								<JsonResult value={{ code: step.code }} />
								<details className="text-sm">
									<summary className="cursor-pointer">Callback URL</summary>
									<p className="mt-2 break-all text-xs text-muted-foreground">
										{step.callbackURL}
									</p>
								</details>
							</>
						) : (
							<p className="text-sm text-muted-foreground">
								No authorization code yet.
							</p>
						)}
						<p className="text-xs text-muted-foreground">
							This walkthrough reads the loopback callback in memory. You stay
							on this page; no local callback server is needed.
						</p>
					</CardContent>
					<CardFooter>
						<Button
							disabled={busy || step?.type !== "code" || exchangeAttempted}
							onClick={() => {
								if (!transaction || step?.type !== "code") return;
								setExchangeAttempted(true);
								void run("Exchanging code for tokens…", async () => {
									setTokens(await exchangeCode(transaction, step.code));
								});
							}}
						>
							{tokens ? "Code exchanged" : "Exchange code for tokens"}
						</Button>
					</CardFooter>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>5. Token response</CardTitle>
						<CardDescription>
							Access, refresh, and ID tokens returned by the token endpoint.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{tokens ? (
							<JsonResult value={tokens} />
						) : (
							<p className="text-sm text-muted-foreground">
								{exchangeAttempted && !busy
									? "Exchange failed. Restart authorization to get a fresh code."
									: "Exchange the authorization code to view tokens."}
							</p>
						)}
					</CardContent>
					<CardFooter>
						<Button
							disabled={busy || !tokens}
							onClick={() => {
								if (!tokens) return;
								void run("Fetching user info…", async () => {
									setUserInfo(undefined);
									setUserInfo(await fetchUserInfo(tokens.access_token));
								});
							}}
						>
							Fetch user info
						</Button>
					</CardFooter>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>6. User info</CardTitle>
						<CardDescription>
							OIDC identity returned using the OAuth access token.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{userInfo ? (
							<JsonResult value={userInfo} />
						) : (
							<p className="text-sm text-muted-foreground">
								Fetch user info after obtaining an access token.
							</p>
						)}
					</CardContent>
				</Card>
			</div>
		</section>
	);
}
