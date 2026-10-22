# Better Auth Demo App

Welcome to the Better Auth demo app!
This project is built with [Next.js](https://nextjs.org) using
[`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Here’s how you can get the app running locally:

### Prerequisites

1. **Clone the repo**:

   ```bash
   git clone https://github.com/better-auth/better-auth
   cd better-auth/demo/nextjs
   ```

2. **Install the dependencies**:

   ```bash
   npm install
   # or
   yarn install
   # or
   pnpm install
   ```

3. **Set up your environment variables**:

   * Rename the `.env.example` file to `.env`:

     ```bash
     mv .env.example .env
     ```

   * Open `.env` and configure your public origin, auth secret, and database
     connection.

Social sign-in providers and Google One Tap are disabled in this demo.
Use email/password or passkey sign-in; social provider credentials are not needed.

This demo runs without Better Auth hosted Infrastructure services or an
Infrastructure API key. Dashboard tracking, Sentinel security checks, and
telemetry are disabled. Password resets, organization invitations, and email
two-factor codes are printed as `[Demo email preview]` messages in the server
console during development. No email is delivered. Configure an email sender in
`lib/email/send.ts` before using these email flows in production.

Make sure `TURSO_DATABASE_URL=your_turso_url` and
`TURSO_AUTH_TOKEN=your_turso_token` is set or `USE_MYSQL=true` and
`MYSQL_DATABASE_URL=your_mysql_url` is set.

### Start the Development Server

On first setup, generate an auth secret if `BETTER_AUTH_SECRET` is not already
configured:

```bash
npx auth@latest secret
```

Copy the generated value into `.env`, replacing the placeholder below:

```dotenv
BETTER_AUTH_SECRET=your-generated-value
```

Next.js loads this value from `.env`. Keep the secret unchanged across restarts
and all server instances sharing the same database. Changing it can cause
`Failed to decrypt private key` errors for existing keys in the `jwks` table.
Generating a new secret does not recover those keys; restore their original
secret or regenerate the signing keys if the original is unavailable.

Once your environment variables are configured, migrate the database before
starting the development server:

```bash
# Create or update the tables required by your auth configuration.
# Run on first setup and after changing the auth schema or enabled plugins.
npx auth@latest migrate --config ./lib/auth.ts

# Start the development server.
pnpm dev
```

The app will be live at [http://localhost:3000](http://localhost:3000).
Open it in your browser, and you’re good to go!

Feel free to jump in and edit the app by modifying `app/page.tsx`.
Any changes you make will update automatically in the browser.

### Accessing the Dev Server from a Remote Host

When accessing the demo through a remote host or IP address, you may see:

```text
⚠ Blocked cross-origin request to Next.js dev resource /_next/hmr from "170.106.176.163".
Cross-origin access to Next.js dev resources is blocked by default for safety.
```

To allow this host in development, add `allowedDevOrigins` to this demo's
`next.config.ts`, keeping the existing options:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	allowedDevOrigins: ["170.106.176.163"],
	typescript: {
		ignoreBuildErrors: true,
	},
	serverExternalPackages: ["libsql"],
};

export default nextConfig;
```

Replace the IP address with the host you use to access the demo, then stop the
running dev server and restart it with `pnpm dev`.
See the [Next.js allowedDevOrigins documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins)
for more details.

If authentication requests report an invalid origin, Better Auth also needs the
public URL used to access the demo:

```text
ERROR [Better Auth]: Invalid origin: http://170.106.176.163
```

Set `BETTER_AUTH_URL` in `.env` to the exact browser origin:

```dotenv
BETTER_AUTH_URL=http://170.106.176.163
```

Include the protocol and port when present. For example, accessing the demo at
`http://170.106.176.163:3000` requires that full URL as `BETTER_AUTH_URL`.
Better Auth automatically trusts its configured base URL. To allow additional
frontend origins, add their full URLs to the existing `trustedOrigins` array in
`lib/auth.ts`. Restart the dev server after changing these settings.
See the [Better Auth trusted origins documentation](https://www.better-auth.com/docs/reference/options#trustedorigins)
for more details.

## Features

Here’s what this app supports out of the box:

* **[Email & Password][]**: Sign up and sign in immediately without sending
  verification emails.
* **[Organization / Teams][]**: Manage users within organizations or teams.
* **[Passkeys][]**: Passwordless login using modern authentication standards.
* **[Multi-Factor Authentication (MFA)][]**: Add an extra layer of security.
* **[Password Reset][]**: Let users reset their passwords if they forget them.
* **[Roles & Permissions][]**: Define and manage who can do what.
* **[Rate Limiting][]**: Protect your app from abuse with smart limits.
* **[Session Management][]**: Handle user sessions seamlessly.
* **[Stripe Plugin][]**: Integrate Stripe for customer management,
  subscriptions, and webhooks.

## Learn More

Here are some helpful links if you want to dive deeper:

* [Better Auth Documentation](https://better-auth.com/docs) - Everything you
  need to know to integrate Better Auth.
* [Next.js Documentation](https://nextjs.org/docs) - Learn about the framework
  we used to build this app.
* [Learn Next.js](https://nextjs.org/learn) - A hands-on tutorial for Next.js.

***

If you run into issues or have suggestions, feel free to open an issue or submit
a pull request on the [GitHub repo](https://github.com/better-auth/better-auth).

Happy coding!

[email & password]: https://www.better-auth.com/docs/basic-usage#email-password

[multi-factor authentication (mfa)]: https://www.better-auth.com/docs/plugins/2fa

[organization / teams]: https://www.better-auth.com/docs/plugins/organization

[passkeys]: https://www.better-auth.com/docs/plugins/passkey

[password reset]: https://www.better-auth.com/docs/concepts/email#password-reset-email

[rate limiting]: https://www.better-auth.com/docs/concepts/rate-limit

[roles & permissions]: https://www.better-auth.com/docs/plugins/admin#role

[session management]: https://www.better-auth.com/docs/concepts/session-management

[stripe plugin]: https://www.better-auth.com/docs/plugins/stripe
