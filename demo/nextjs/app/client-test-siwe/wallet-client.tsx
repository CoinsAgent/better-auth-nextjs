"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useSessionQuery } from "@/data/user/session-query";
import { useSignOutMutation } from "@/data/user/sign-out-mutation";
import { authClient } from "@/lib/auth-client";
import { OAuthPlayground } from "./oauth-playground";
import type { EthereumProvider } from "./siwe-login";
import { signInWithWallet } from "./siwe-login";

/** Run the client walkthrough with an Ethereum wallet as the sign-in method. */
export function WalletClientTest({ origin }: { origin: string }) {
	const {
		data: session,
		isPending,
		error: sessionError,
		refetch,
	} = useSessionQuery();
	const signOut = useSignOutMutation();
	const [status, setStatus] = useState<string>();
	const [message, setMessage] = useState<string>();
	const [error, setError] = useState<string>();
	const {
		data: accounts,
		error: accountsError,
		isFetching: loadingAccounts,
	} = useQuery({
		queryKey: ["client-test-siwe", "accounts", session?.user.id],
		enabled: !!session,
		async queryFn() {
			const result = await authClient.listAccounts();
			if (result.error) throw new Error(result.error.message);
			return result.data;
		},
	});
	const walletAccounts =
		accounts?.filter((account) => account.providerId === "siwe") ?? [];
	const hasWalletSession =
		!!session && walletAccounts.length > 0 && !accountsError;

	async function signIn() {
		setError(undefined);
		setMessage(undefined);
		setStatus("Connecting wallet…");
		try {
			if (window.location.origin !== origin) {
				throw new Error(
					`Open ${origin}, or set BETTER_AUTH_URL to ${window.location.origin} and restart the demo.`,
				);
			}
			const provider = (window as Window & { ethereum?: EthereumProvider })
				.ethereum;
			if (!provider?.request) {
				throw new Error(
					"No Ethereum wallet found. Open this page in a browser with an Ethereum wallet available.",
				);
			}
			await signInWithWallet(
				provider,
				origin,
				authClient.siwe,
				(signedMessage) => {
					setMessage(signedMessage);
					setStatus("Confirm the sign-in message in your wallet…");
				},
			);
			await refetch();
			toast.success("Signed in with Ethereum");
		} catch (cause) {
			const rejected =
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === 4001;
			setError(
				rejected
					? "Wallet request declined. You can try signing in again."
					: cause instanceof Error
						? cause.message
						: "Wallet sign-in failed. Please try again.",
			);
		} finally {
			setStatus(undefined);
		}
	}

	return (
		<div className="container mx-auto space-y-8 py-10">
			<h1 className="text-center text-2xl font-bold">
				SIWE Client Authentication & OAuth Test
			</h1>
			<div className="grid grid-cols-1 gap-8 md:grid-cols-2">
				<Card className="min-w-0">
					<CardHeader>
						<CardTitle>1. Sign in with Ethereum</CardTitle>
						<CardDescription>
							Connect your wallet and sign a message to authenticate. No gas
							fee.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="break-all text-sm text-muted-foreground">
							Sign-in domain: {new URL(origin).host}
						</p>
						{walletAccounts.map((account) => (
							<div key={account.id} className="rounded-md bg-muted p-3 text-sm">
								<p className="font-medium">Authenticated wallet</p>
								<p className="break-all font-mono text-xs">
									{account.accountId.split(":")[0]}
								</p>
								<p className="text-muted-foreground">
									Chain ID: {account.accountId.split(":")[1]}
								</p>
							</div>
						))}
						{status && (
							<p role="status" className="text-sm">
								{status}
							</p>
						)}
						{error && (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						)}
						{message && (
							<details className="text-sm">
								<summary className="cursor-pointer">SIWE message</summary>
								<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
									{message}
								</pre>
							</details>
						)}
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							onClick={() => void signIn()}
							disabled={!!status || signOut.isPending}
						>
							{status ? (
								<Loader2 size={16} className="mr-2 animate-spin" />
							) : (
								<Wallet size={16} className="mr-2" />
							)}
							{status ? "Signing in…" : "Sign in with Ethereum"}
						</Button>
					</CardFooter>
				</Card>
				<Card className="min-w-0">
					<CardHeader>
						<CardTitle>2. Session information</CardTitle>
						<CardDescription>
							{isPending || (session && loadingAccounts)
								? "Loading session…"
								: hasWalletSession
									? "You are signed in with a wallet account."
									: session
										? "Sign in with Ethereum to continue with a wallet account."
										: "You are not logged in."}
						</CardDescription>
					</CardHeader>
					<CardContent>
						{(sessionError || accountsError) && (
							<p role="alert" className="text-sm text-destructive">
								{sessionError?.message || accountsError?.message}
							</p>
						)}
						{session ? (
							<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-4 text-xs">
								{JSON.stringify(session, null, 2)}
							</pre>
						) : (
							<p className="text-sm text-muted-foreground">
								Sign in with your wallet to view your session.
							</p>
						)}
					</CardContent>
					{session && (
						<CardFooter>
							<Button
								className="w-full"
								variant="outline"
								disabled={signOut.isPending || !!status}
								onClick={() =>
									signOut.mutate(undefined, {
										onSuccess: () => setMessage(undefined),
									})
								}
							>
								{signOut.isPending ? "Signing out…" : "Sign out"}
							</Button>
						</CardFooter>
					)}
				</Card>
			</div>
			<OAuthPlayground
				key={session?.session.id ?? "signed-out"}
				user={hasWalletSession ? session?.user : undefined}
			/>
		</div>
	);
}
