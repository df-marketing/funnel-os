"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * The door, and there are two ways through it.
 *
 * A password, for anybody who has set one. And a link by email, for anybody who
 * has not — which is every client provisioned from AcqOS, because those accounts
 * are created without a password on purpose so there is nothing to fall out of
 * step with AcqOS's copy.
 *
 * No sign-up link. Accounts are created by AcqOS at signup or by DriveFunnels by
 * hand; this is a reporting tool for named clients, not something to be
 * discovered and joined.
 */

const MESSAGES: Record<string, string> = {
  "link-expired": "That sign-in link has expired or was already used. Ask for a new one below.",
  "missing-code": "That link was incomplete. Ask for a new one below.",
};

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(MESSAGES[params.get("error") ?? ""] ?? null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSent(false);

    const { error } = await createClient().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      /* Supabase answers "Invalid login credentials" for a wrong password AND
         for an address with no account, deliberately — telling them apart tells
         an attacker which addresses exist. Passed through, with the one hint
         that is safe to give because it is true for everybody. */
      setError(`${error.message}. If you have never set a password, use the link option below.`);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  async function emailLink() {
    if (!email) { setError("Enter your email address first."); return; }
    setBusy(true); setError(null);
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    /* Said the same way whether or not the address exists, for the reason
       above. It is also simply true: a link was sent, if there was anywhere to
       send it. */
    setSent(true);
  }

  return (
    <main className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Funnel OS</h1>
        <p className="dim">Reporting and attribution for DriveFunnels.</p>

        <label>
          Email
          <input type="email" value={email} autoComplete="username" required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label>
          Password
          <input type="password" value={password} autoComplete="current-password"
                 onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error ? <p className="login-error">{error}</p> : null}
        {sent ? <p className="login-sent">Check your email — a sign-in link is on its way.</p> : null}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <button className="btn" type="button" disabled={busy} onClick={emailLink}>
          Email me a sign-in link
        </button>

        <p className="cro-foot">
          No password yet? Use the link — it signs you in and you can set one
          afterwards. Access is arranged by DriveFunnels; if you cannot get in,
          ask whoever sent you this.
        </p>
      </form>
    </main>
  );
}

/**
 * useSearchParams() opts a page out of static rendering, and Next refuses to
 * prerender one without a boundary rather than silently shipping a blank shell.
 * The fallback is the same card without the message, so a slow hydrate shows a
 * login form rather than nothing.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="login-wrap">
        <div className="login"><h1>Funnel OS</h1><p className="dim">Loading…</p></div>
      </main>
    }>
      <LoginForm />
    </Suspense>
  );
}
