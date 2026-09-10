"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * The door.
 *
 * Email and password, and nothing else — no sign-up link, no magic link, no
 * social login. Accounts are created by DriveFunnels in the Supabase dashboard
 * and granted a client by hand. This is a reporting tool for named clients, not
 * a product somebody discovers and signs up to, and a sign-up form would invite
 * exactly the account nobody meant to create.
 *
 * Nothing sends anybody here until FUNNEL_REQUIRE_LOGIN is set. The page works
 * before then, which is how it gets tested without locking anyone out.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const db = createClient();
    const { error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      setBusy(false);
      /* Supabase says "Invalid login credentials" for a wrong password AND for
         an address with no account, on purpose — telling them apart tells an
         attacker which addresses exist. Passed through rather than improved. */
      setError(error.message);
      return;
    }

    // refresh() so the server re-reads the session it was just handed; push()
    // alone can render the destination against the cookie state from before.
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Funnel OS</h1>
        <p className="dim">Reporting and attribution for DriveFunnels.</p>

        <label>
          Email
          <input
            type="email" value={email} autoComplete="username" required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label>
          Password
          <input
            type="password" value={password} autoComplete="current-password" required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="cro-foot">
          Access is arranged by DriveFunnels. If you cannot get in, ask the
          person who sent you this link.
        </p>
      </form>
    </main>
  );
}
