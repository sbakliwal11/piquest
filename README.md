# Stepwise PWA — beginner-friendly setup

Stepwise is a mobile-first learning PWA for Maths and Physics questions. It includes:
- Username/password-style registration and login through Supabase Auth.
- Typed questions, image upload, and camera capture.
- AI transcription for image-only questions.
- Shared question/solution cache in Supabase.
- Four explanation modes: clue, casual approach, expandable logical steps, and a simpler detailed explanation.
- A private question history per account.
- PWA manifest, icons, a basic service worker, and an offline fallback page.

## Important limitations of this first version

1. AI can make mistakes, especially when reading tiny symbols or complex diagrams. The recognized question is shown with the result; if the transcription is wrong, start a new question and type the corrected text. A dedicated OCR confirmation/edit screen should be added before a larger public launch.
2. Exact normalized-text matching is used for the shared cache. Semantically equivalent questions written differently may not match.
3. Stepwise presents explanations in text and equations; it does not display generated diagrams.
4. The login form maps each username to a synthetic email at `users.stepwise.invalid`. This allows a username-shaped login UI without collecting email addresses, but there is no email-based password recovery. Disable email confirmation in Supabase Auth. If Supabase rejects the synthetic domain in your project, switch to real email/password authentication or implement a server-side username lookup.
5. The service worker provides an offline fallback page only. It does not cache private history, auth responses, AI requests, or solutions.
6. AI API usage may cost money and has rate limits. "Free for students" is a product decision, not a guarantee that AI inference is free.

## Requirements

- Node.js 20.9 or newer (Node 22 LTS recommended)
- A Supabase account/project
- A OpenAI API key with access to a vision-capable model
- A Vercel account for deployment
- Git and a GitHub account (recommended)

## 1. Run locally on Windows

1. Install Node.js LTS from https://nodejs.org/ . Close and reopen VS Code after installing.
2. Extract this ZIP into a folder such as `C:\Users\YOUR_NAME\Desktop\stepwise-pwa`.
3. Open that folder in VS Code: File → Open Folder.
4. Open Terminal → New Terminal.
5. Run:

   ```powershell
   npm install
   ```

6. Copy `.env.example` to `.env.local`. Fill in the real values from Supabase and OpenAI. Never put a real key in source code or commit `.env.local`.
7. Run:

   ```powershell
   npm run dev
   ```

8. Open http://localhost:3000 in your browser. Keep the terminal running while you use the app.

## 2. Create Supabase and set up the database

1. Go to https://supabase.com/ and create a new project.
2. Save the database password somewhere safe.
3. Open Project Settings / Connect (the dashboard wording may change). Copy:
   - Project URL
   - Publishable key (or the legacy `anon` key if that is what your project provides)
   - Secret/service-role key for server-only use
4. In Supabase, open SQL Editor → New query.
5. Open `supabase/schema.sql` from this project, copy all of it into the SQL editor, and run it.
6. Open Authentication → Providers → Email (the exact menu may vary). Enable email/password sign-in and turn **off email confirmation** for this prototype.
7. Under Authentication settings, ensure password length requirements are at least 8 characters. Keep any built-in rate limiting enabled.
8. In Authentication URL settings, add your local site URL `http://localhost:3000` to allowed redirect/site URLs if the dashboard requires it.
9. In `.env.local`, set:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
10. The service-role key is extremely powerful. It must be used only in server-side API routes and must never have a `NEXT_PUBLIC_` prefix.

## 3. Create a Groq API key

1. Go to https://console.groq.com/ and sign in.
2. Create an API key in the API Keys section.
3. Confirm that your account can use the vision-capable model configured in `.env.local`. The default in this project is `gpt-6-luna`; model availability can change.
4. Put the key in `OPENAI_API_KEY` in `.env.local`.
5. Keep `OPENAI_API_KEY` server-only: never prefix it with `NEXT_PUBLIC_`, never paste it into frontend code, and never commit it to GitHub.
6. Usage is subject to Groq's current model access, rate limits, and pricing.

## 4. Test the app before deployment

1. Restart the local server after editing `.env.local` (Ctrl+C, then `npm run dev`).
2. Register a test username and password.
3. If registration returns without logging in, confirm that email confirmation is disabled in Supabase.
4. Type a simple question and select **Help me learn**.
5. Check each of the four explanation modes.
6. Submit the same question again. It should use the cached question-bank solution.
7. Open History and check that the question is listed.
8. Log out, register a second test account, and verify that it cannot see the first account's history.
9. Test image upload with a clear, small photo.
10. On a mobile device, open the deployed HTTPS URL to test camera capture and PWA installation.

## 5. Put the project on GitHub

1. Create a new empty repository on https://github.com/.
2. In VS Code terminal, from the project folder, run:

   ```powershell
   git init
   git add .
   git commit -m "Initial Stepwise PWA"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/stepwise-pwa.git
   git push -u origin main
   ```

3. Do not add `.env.local` to Git. It is ignored by `.gitignore`. Before pushing, run `git status` and ensure no secrets are listed.

If Git is not installed, install it from https://git-scm.com/downloads and reopen the terminal.

## 6. Deploy to Vercel

1. Go to https://vercel.com/ and sign in with GitHub.
2. Choose Add New → Project and import your `stepwise-pwa` repository.
3. Vercel should detect Next.js automatically.
4. In the project setup or Project Settings → Environment Variables, add the same four variables from `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   Also add `OPENAI_MODEL` if you changed it.
5. Apply them to Production and Preview as appropriate. Do not add secrets to the `NEXT_PUBLIC_` namespace.
6. Click Deploy and wait for the build to finish.
7. Open the generated `https://...vercel.app` URL and test registration, login, question solving, cache reuse, history and image upload.
8. If you change environment variables, redeploy so the new values take effect.
9. In Supabase Authentication URL settings, add your production Vercel URL to the allowed site URLs if needed.
10. Vercel creates preview deployments for future Git pushes. Test a preview before merging important changes into `main`.

Official references:
- Next.js PWA guide: https://nextjs.org/docs/app/guides/progressive-web-apps
- Supabase Next.js Auth quickstart: https://supabase.com/docs/guides/auth/quickstarts/nextjs
- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Vercel environment variables: https://vercel.com/docs/environment-variables

## 7. Install it on a phone

1. Open the production HTTPS URL in Chrome on Android.
2. Open the browser menu and choose **Install app** or **Add to Home screen** (wording varies).
3. Confirm installation. The Stepwise icon should appear on the home screen.
4. Open it from the icon to use the standalone app experience.
5. Test camera capture. Browser permission may be required.
6. On iPhone, open the site in Safari, tap Share, then Add to Home Screen.

The first version is a PWA, not an app-store binary. It runs on the web and can be installed from the browser.

## 8. Common problems

### `npm` is not recognized
Install Node.js LTS, restart VS Code, then run `node -v` and `npm -v`.

### Supabase URL/key missing
Check `.env.local` spelling and restart `npm run dev`. Environment variable names must match exactly.

### Registration asks for confirmation
Turn off Confirm email in Supabase Auth settings for this prototype. Do not deploy widely until you've decided whether username-only accounts and lack of recovery are appropriate.

### Login says invalid credentials
Usernames are lowercased. Use the exact username and password used at registration. A username cannot be recovered from email because the prototype does not collect email.

### `OPENAI_API_KEY is missing`
Add the key to `.env.local`, stop the dev server, and restart it. In Vercel, add the key under Environment Variables and redeploy.

### Model not found or access denied
Open OpenAI and check the current model IDs available to your account. Update `OPENAI_MODEL` accordingly and redeploy.

### Database lookup fails
Run `supabase/schema.sql` completely. Confirm RLS is enabled and the user is logged in. Check the API route logs in the local terminal or Vercel deployment logs.

### AI generated solution was not saved
Check that `SUPABASE_SERVICE_ROLE_KEY` is correct and is set only as a server-side Vercel variable. Never expose it in client code.

### Camera doesn't open
Camera access usually requires HTTPS in production and browser permission. The camera input also depends on device/browser support; the upload button is the fallback.

### PWA does not show an install option
Use the production HTTPS URL, check the browser's install menu, and confirm the manifest and 192/512 PNG icons load successfully. PWA install prompts vary by browser and device.

## Before opening this to the public

Add request rate limiting, abuse protection/CAPTCHA, input validation, a visible AI error-reporting flow, an OCR correction screen, cost monitoring, privacy/terms pages, and automated tests for database policies. Consider real email login or a carefully designed username lookup flow if students need account recovery.


## Optional OpenAI diagram generation

Stepwise keeps Qwen/Groq responsible for the solution and pseudo-XML instructions. A separate OpenAI Images API request turns the XML into a PNG diagram. Diagram generation is best-effort: if it fails, the generated solution is still returned and saved. Successful PNGs are saved in the Supabase Storage bucket configured by `SUPABASE_DIAGRAM_BUCKET` (default `stepwise-diagrams`), and their metadata is saved in the existing `question_bank.solution` JSON field. The bucket is created automatically by the server when needed.

Add these server-side environment variables to `.env.local` and to your deployment provider (for example, Vercel Project Settings → Environment Variables):

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_IMAGE_MODEL=gpt-image-1.5
SUPABASE_DIAGRAM_BUCKET=stepwise-diagrams
```

Keep `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` server-only; do not prefix them with `NEXT_PUBLIC_` or expose them in browser code. OpenAI API billing is separate from a ChatGPT subscription. The first request that needs a diagram may take longer because it generates and stores the image. Cached questions reuse the saved image; if a previous diagram attempt failed, a later request retries it.
