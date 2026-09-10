"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Set a password, having arrived without one.
 *
 * Provisioned accounts have no password by design, and a link by email works
 * every time — but GroundTruth's Supabase sends that mail, and on the current
 * plan it is rate-limited to a handful an hour. A client who waits twenty
 * minutes to read their own numbers will conclude the product is broken, and
 * they will be close enough to right.
 *
 * So the link is how you get in the first time, and this is how you stop needing
 * it. Reachable only with a session, because setting a password for somebody
 * else is the entire thing an unauthenticated version of this page would be.
 */
export default function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    if (password.length < 8) { setError("Use at least 8 characters."); return; }

    setBusy(true); setError(null);
    const db = createClient();

    /* Checked here rather than relying on updateUser to fail: without a session
       it returns an auth error whose message is about tokens, and the person
       reading it needs to know their link expired, not what a JWT is. */
    const { data: { user } } = await db.auth.getUser();
    if (!user) {
      setBusy(false);
      setError("Your sign-in has expired. Go back and ask for a new link.");
      return;
    }

    const { error } = await db.auth.updateUser({ password });
    setBusy(false);
    if (error) { setError(error.message); return; }

    setDone(true);
    setTimeout(() => { router.replace("/"); router.refresh(); }, 1200);
  }

  return (
    <main className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Set a password</h1>
        <p className="dim">So you do not need an email link every time.</p>

        <label>
          New password
          <input type="password" value={password} autoComplete="new-password" required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>

        <label>
          Again
          <input type="password" value={confirm} autoComplete="new-password" required
                 onChange={(e) => setConfirm(e.target.value)} />
        </label>

        {error ? <p className="login-error">{error}</p> : null}
        {done ? <p className="login-sent">Saved. Taking you to your dashboard…</p> : null}

        <button className="btn primary" type="submit" disabled={busy || done}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </form>
    </main>
  );
}
