# SIWE browser walkthrough

Open `/client-test-siwe` on the running demo in a browser with an injected
Ethereum wallet. This page uses Better Auth's SIWE plugin instead of an
email/password form.

1. Click **Sign in with Ethereum**, connect an account, and approve the sign-in
   message in your wallet.
2. Inspect the authenticated wallet, Chain ID, and Better Auth session.
3. Click **Start authorization**, review the OAuth permissions, and allow or deny
   consent.
4. Exchange the authorization code for tokens, then fetch UserInfo.

The message contains the current wallet address, Chain ID, server-issued nonce,
configured domain, page URI, and a five-minute expiration. The server verifies
the signature locally and the SIWE plugin consumes each nonce once. This demo
supports externally owned accounts; it does not send blockchain transactions or
make RPC requests.

Set `BETTER_AUTH_URL` to the exact browser origin, including the port, before
starting the server. The page refuses to request a signature for a different
configured origin.

The SIWE plugin requires a `walletAddress` table. On a new database or after
adding this plugin to another checkout, migrate before starting the demo:

```bash
npx auth@latest migrate --config ./lib/auth.ts
pnpm dev
```

No email input is required. Better Auth stores an unverified wallet-derived
placeholder email because its user schema requires an email. Wallet sign-in
creates a normal Better Auth session, which the OAuth flow then uses.

Run the focused tests from the Next.js demo directory:

```bash
pnpm --dir ../.. exec vitest run --config demo/nextjs/app/client-test-siwe/vitest.config.ts
```
