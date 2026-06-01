"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, signup, storeToken } from "@/lib/api";

export default function SetupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login" | "ready">("signup");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function createOrg(): Promise<void> {
    setError(null);
    try {
      const result = await signup({ orgName, adminEmail: email, adminPassword: password });
      storeToken(result.token);
      setWebhookUrl(result.webhookUrl);
      setMode("ready");
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create OperaIQ");
    }
  }

  async function signIn(): Promise<void> {
    setError(null);
    try {
      const result = await login({ email, password });
      storeToken(result.token);
      router.replace("/");
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in");
    }
  }

  async function copyWebhook(): Promise<void> {
    await navigator.clipboard.writeText(webhookUrl);
  }

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground">
      <section className="mx-auto max-w-[720px] border border-border bg-panel">
        <div className="border-b border-border px-4 py-3 font-mono text-[14px] font-semibold uppercase tracking-[0.18em]">OperaIQ</div>
        <div className="space-y-5 p-4 md:p-6">
          {mode !== "ready" ? (
            <>
              <div>
                <h1 className="max-w-full break-words font-mono text-[16px] uppercase leading-7 tracking-[0.08em] sm:text-[18px]">Set up your team's OperaIQ agent.</h1>
                <p className="mt-2 text-[13px] text-muted">Each team gets an isolated incident feed, Qdrant brain, services, runbooks, and post-mortems.</p>
              </div>
              {mode === "signup" ? (
                <label className="block text-[13px] text-muted">
                  Org name
                  <input className="mt-1 w-full border border-border bg-background px-3 py-2 font-mono text-[14px] text-foreground outline-none focus:border-active" value={orgName} onChange={(event) => setOrgName(event.target.value)} />
                </label>
              ) : null}
              <label className="block text-[13px] text-muted">
                Admin email
                <input className="mt-1 w-full border border-border bg-background px-3 py-2 font-mono text-[14px] text-foreground outline-none focus:border-active" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="block text-[13px] text-muted">
                Password
                <input className="mt-1 w-full border border-border bg-background px-3 py-2 font-mono text-[14px] text-foreground outline-none focus:border-active" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              {error ? <div className="border border-critical px-3 py-2 text-[13px] text-critical">{error}</div> : null}
              <div className="flex flex-wrap items-center gap-3">
                <button className="border border-active bg-active px-4 py-2 font-mono text-[12px] uppercase tracking-[0.08em] text-background" onClick={mode === "signup" ? createOrg : signIn}>
                  {mode === "signup" ? "Create OperaIQ ->" : "Sign in ->"}
                </button>
                <button className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted hover:text-foreground" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
                  {mode === "signup" ? "Already have an account? Sign in" : "Need a new OperaIQ? Create one"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <h1 className="max-w-full break-words font-mono text-[16px] uppercase leading-7 tracking-[0.08em] sm:text-[18px]">OPERAIQ is ready.</h1>
                <p className="mt-2 text-[13px] text-muted">Send incidents to this URL. OperaIQ will retrieve Qdrant memory, act, verify, and write the post-mortem back to memory.</p>
              </div>
              <div>
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-deep">Your webhook URL</div>
                <div className="break-all border border-border bg-background p-3 font-mono text-[12px] text-active">{webhookUrl}</div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button className="border border-border px-4 py-2 font-mono text-[12px] uppercase tracking-[0.08em] text-foreground" onClick={copyWebhook}>
                  Copy webhook URL
                </button>
                <button className="border border-active bg-active px-4 py-2 font-mono text-[12px] uppercase tracking-[0.08em] text-background" onClick={() => router.replace("/")}>
                  Open OperaIQ {"->"}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
