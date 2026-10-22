# OAuth/OIDC CLI walkthrough

<!-- cspell:ignore dgst -->

Run each Bash block in order in the **same terminal**. Variables and cookies must
survive between steps. Stop and inspect the response if a command fails.
These commands follow `oauth-token.sh`, with an additional email sign-in request
so you can exercise both signup and sign-in. No commands prompt for input.

Prerequisites: a running demo, Bash, cURL 7.76 or newer, jq, OpenSSL, and Node.js.
`BASE_URL` must match the demo's configured public origin, including its port.
The shell does not load `.env` automatically.

## 1. Configure the origin, cookies, and HTTP helper

```bash
cd /home/ubuntu/better-auth-nextjs/demo/nextjs

# Change this URL if you use a different demo origin.
BASE_URL='http://170.106.176.163'
REDIRECT_URI='http://127.0.0.1:8765/callback'
COOKIE_FILE=$(mktemp)

# Preserve session cookies and request JSON responses instead of HTTP redirects.
# Print request progress and HTTP status to stderr, keeping stdout valid JSON.
# --fail-with-body preserves error details and returns a nonzero status on failure.
# Do not add --location/-L: the loopback callback must be parsed, not requested.
api() {
	local method="$1" path="$2"
	shift 2
	printf '[oauth] %s %s\n' "$method" "${path%%\?*}" >&2

	curl --fail-with-body --silent --show-error \
		--connect-timeout 10 --max-time 60 \
		--cookie "$COOKIE_FILE" --cookie-jar "$COOKIE_FILE" \
		-H "Origin: $BASE_URL" \
		-H 'Accept: application/json' \
		--request "$method" "$BASE_URL$path" \
		--write-out '%{stderr}[oauth] HTTP %{http_code}\n' \
		"$@"
}

# Expected: HTTP 200 and {"ok":true}. Resolve server errors before continuing.
api GET '/api/auth/ok' | jq .
```

## 2. Create a test account

Skip this step if you want to use an existing account; follow the comments in
step 3 instead. Each execution of this signup block creates a new database user.

```bash
# Generate credentials without printing the password.
EMAIL="oauth-cli-$(openssl rand -hex 8)@example.com"
PASSWORD=$(openssl rand -hex 24)

LOGIN_BODY=$(jq -n \
	--arg email "$EMAIL" \
	--arg password "$PASSWORD" \
	'{email:$email, password:$password, name:"OAuth CLI Test"}')

# Signup automatically signs the user in and saves the session in COOKIE_FILE.
AUTHENTICATION=$(api POST '/api/auth/sign-up/email' \
	-H 'Content-Type: application/json' \
	--data "$LOGIN_BODY")

USER_ID=$(printf '%s' "$AUTHENTICATION" | jq -er '.user.id')
printf '%s' "$AUTHENTICATION" | jq '.user | {id,email}'
```

## 3. Test email/password sign-in

```bash
# After signup, reuse EMAIL and PASSWORD from step 2.
# For an existing account, set both credentials before running this block:
# EMAIL="$OAUTH_EMAIL"
# PASSWORD="$OAUTH_PASSWORD"
# Accounts requiring MFA need that additional authentication flow; the existing
# script and this walkthrough use accounts that can authenticate directly.

LOGIN_BODY=$(jq -n \
	--arg email "$EMAIL" \
	--arg password "$PASSWORD" \
	'{email:$email, password:$password}')

AUTHENTICATION=$(api POST '/api/auth/sign-in/email' \
	-H 'Content-Type: application/json' \
	--data "$LOGIN_BODY")

USER_ID=$(printf '%s' "$AUTHENTICATION" | jq -er '.user.id')
printf '%s' "$AUTHENTICATION" | jq '.user | {id,email}'
unset PASSWORD LOGIN_BODY AUTHENTICATION
```

## 4. Register a public native OAuth client

```bash
# Native clients support HTTP loopback callbacks. Public clients do not require
# a client secret. The refresh_token grant and offline_access scope enable
# refresh token issuance alongside access and OIDC ID tokens.
REGISTRATION_BODY=$(jq -n --arg redirect "$REDIRECT_URI" '{
	client_name:"CLI OAuth Test",
	application_type:"native",
	redirect_uris:[$redirect],
	token_endpoint_auth_method:"none",
	grant_types:["authorization_code","refresh_token"],
	response_types:["code"],
	scope:"openid profile email offline_access"
}')

REGISTRATION=$(api POST '/api/auth/oauth2/register' \
	-H 'Content-Type: application/json' \
	--data "$REGISTRATION_BODY")

# Expected: HTTP 201 and a nonempty client_id.
CLIENT_ID=$(printf '%s' "$REGISTRATION" | jq -er '.client_id')
printf 'Client ID: %s\n' "$CLIENT_ID"
```

## 5. Generate PKCE, state, and nonce

```bash
# Keep these values unchanged through the token exchange.
# The verifier stays local; only its SHA-256 base64url challenge is authorized.
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf '%s' "$VERIFIER" \
	| openssl dgst -sha256 -binary \
	| openssl base64 -A \
	| tr '+/' '-_' \
	| tr -d '=')

# State binds the callback to this request. Nonce is included for OIDC.
STATE=$(openssl rand -hex 16)
NONCE=$(openssl rand -hex 16)
printf 'PKCE method: S256\nChallenge: %s\n' "$CHALLENGE"
```

## 6. Start authorization

```bash
# cURL URL-encodes each authorization parameter. The response contains the next
# URL as JSON; it may point to account selection, consent, or the final callback.
AUTH=$(api GET '/api/auth/oauth2/authorize' \
	--get \
	--data-urlencode 'response_type=code' \
	--data-urlencode "client_id=$CLIENT_ID" \
	--data-urlencode "redirect_uri=$REDIRECT_URI" \
	--data-urlencode 'scope=openid profile email offline_access' \
	--data-urlencode "code_challenge=$CHALLENGE" \
	--data-urlencode 'code_challenge_method=S256' \
	--data-urlencode "state=$STATE" \
	--data-urlencode "nonce=$NONCE")

printf '%s' "$AUTH" | jq .
```

## 7. Select the authenticated account

Define this helper first. It validates the destination and preserves the signed
OAuth query exactly as the server returned it.

```bash
signed_query() {
	AUTH_JSON="$AUTH" TARGET_PATH="$1" BASE_URL="$BASE_URL" \
		node --input-type=module -e '
			const url = new URL(
				JSON.parse(process.env.AUTH_JSON).url,
				process.env.BASE_URL
			);
			if (
				url.origin !== new URL(process.env.BASE_URL).origin ||
				url.pathname !== process.env.TARGET_PATH
			) {
				throw new Error("Unexpected authorization step");
			}
			console.log(url.search.slice(1));
		'
}
```

Run the next block **only if** the returned URL points to
`/oauth/select-account`. Otherwise proceed to step 8 or 9 as appropriate.

```bash
# Continue with the account already active in COOKIE_FILE.
QUERY=$(signed_query '/oauth/select-account')
BODY=$(jq -n --arg query "$QUERY" '{selected:true, oauth_query:$query}')

AUTH=$(api POST '/api/auth/oauth2/continue' \
	-H 'Content-Type: application/json' \
	--data "$BODY")

printf '%s' "$AUTH" | jq .
```

## 8. Grant consent

Run this block **only if** the returned URL points to `/oauth/consent`.
If it already points to the loopback callback, proceed to step 9.

```bash
# Approve the scopes for the authenticated account using the signed query.
QUERY=$(signed_query '/oauth/consent')
BODY=$(jq -n --arg query "$QUERY" '{accept:true, oauth_query:$query}')

AUTH=$(api POST '/api/auth/oauth2/consent' \
	-H 'Content-Type: application/json' \
	--data "$BODY")

printf '%s' "$AUTH" | jq .
```

## 9. Validate the callback and extract the authorization code

```bash
# Parse the callback locally. No listener is needed on 127.0.0.1:8765.
# Reject the wrong destination, a missing/duplicate/mismatched state, OAuth
# errors, and missing/duplicate authorization codes before exchanging anything.
CODE=$(AUTH_JSON="$AUTH" EXPECTED_STATE="$STATE" \
	REDIRECT_URI="$REDIRECT_URI" \
	node --input-type=module -e '
		const callback = new URL(JSON.parse(process.env.AUTH_JSON).url);
		const expected = new URL(process.env.REDIRECT_URI);
		if (
			callback.origin !== expected.origin ||
			callback.pathname !== expected.pathname
		) {
			throw new Error("Unexpected callback address");
		}
		if (
			callback.searchParams.getAll("state").length !== 1 ||
			callback.searchParams.get("state") !== process.env.EXPECTED_STATE
		) {
			throw new Error("Callback state mismatch");
		}
		if (callback.searchParams.has("error")) {
			throw new Error(
				callback.searchParams.get("error_description") ||
				callback.searchParams.get("error")
			);
		}
		const codes = callback.searchParams.getAll("code");
		if (codes.length !== 1 || !codes[0]) {
			throw new Error("Missing or duplicate authorization code");
		}
		console.log(codes[0]);
	')

printf 'Authorization code received; state verified.\n'
```

## 10. Exchange the code for tokens

```bash
# The token endpoint accepts form data. The code is single-use, and the original
# client ID, redirect URI, and PKCE verifier must match the authorization request.
TOKENS=$(api POST '/api/auth/oauth2/token' \
	-H 'Content-Type: application/x-www-form-urlencoded' \
	--data-urlencode 'grant_type=authorization_code' \
	--data-urlencode "client_id=$CLIENT_ID" \
	--data-urlencode "redirect_uri=$REDIRECT_URI" \
	--data-urlencode "code=$CODE" \
	--data-urlencode "code_verifier=$VERIFIER")

printf '%s' "$TOKENS" | jq .
ACCESS_TOKEN=$(printf '%s' "$TOKENS" | jq -er '.access_token')
```

Expect an access token, token type, and expiry, plus refresh and ID tokens for
the granted scopes. This follows the script: it does not exchange refresh tokens
or verify ID tokens. Restart authorization with fresh PKCE values if the code
expires or has already been exchanged.

## 11. Fetch UserInfo and check the authenticated identity

```bash
# Pass the access token to UserInfo, then compare its subject to the user ID
# returned by email authentication. Expected: HTTP 200 and a final true value.
USERINFO=$(api GET '/api/auth/oauth2/userinfo' \
	-H "Authorization: Bearer $ACCESS_TOKEN")

printf '%s' "$USERINFO" | jq .
printf '%s' "$USERINFO" | jq -e --arg id "$USER_ID" '.sub == $id'
```

## 12. Remove local cookies and clear sensitive variables

```bash
# This only removes the local cookie file. The user, OAuth client, and consent
# remain in the demo database; issued tokens are not revoked by local cleanup.
rm -f "$COOKIE_FILE"
unset ACCESS_TOKEN TOKENS AUTH CODE VERIFIER BODY QUERY
unset AUTHENTICATION LOGIN_BODY PASSWORD USERINFO
```
