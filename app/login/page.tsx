"use client";

import { signIn, useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function LoginContent() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const source = searchParams.get("source");
  const [sent, setSent] = useState(false);
  const [tokenData, setTokenData] = useState<any>(null);

  useEffect(() => {
    // If logged in and came from extension, get a token for the extension
    if (session && source === "extension" && !sent) {
      const fetchToken = async () => {
        try {
          // Call our API to get a token the extension can use
          const res = await fetch("/api/auth/extension-token");
          if (res.ok) {
            const data = await res.json();
            // postMessage to the content script
            window.postMessage(
              {
                type: "ANSWER_SYNC_AUTH",
                token: data.token,
                user: {
                  email: data.email,
                  name: data.name,
                  tier: data.tier || "free",
                  dailyCreditsUsed: data.dailyCreditsUsed || 0,
                  dailyCreditLimit: data.dailyCreditLimit || 20,
                },
              },
              window.location.origin
            );
            setTokenData(data);
            setSent(true);
          }
        } catch (e) {
          console.error("Failed to send auth to extension:", e);
        }
      };

      fetchToken();
    }
  }, [session, source, sent]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-white/10 border-t-purple-500 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Already logged in
  if (session) {
    if (source === "extension") {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <div className="max-w-md w-full text-center">
            <div className="w-20 h-20 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center text-4xl mx-auto mb-6">
              ✅
            </div>
            <h1 className="text-2xl font-bold mb-3">Connected!</h1>
            <p className="text-gray-400 mb-6">
              You&apos;re signed in as{" "}
              <span className="text-white font-medium">{session.user?.email}</span>.
              <br />
              {sent
                ? "Your extension is now connected. You can close this tab."
                : "Connecting to extension..."}
            </p>
            {!sent && (
              <div className="w-6 h-6 border-2 border-white/10 border-t-purple-500 rounded-full animate-spin mx-auto"></div>
            )}
          </div>
        </div>
      );
    }

    // Regular login — redirect to dashboard
    if (typeof window !== "undefined") {
      window.location.href = "/dashboard";
    }
    return null;
  }

  // Not logged in — show login
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="text-4xl mb-4">✨</div>
          <h1 className="text-3xl font-bold mb-2">Sign in to Answer Sync</h1>
          <p className="text-gray-400">
            {source === "extension"
              ? "Sign in to connect your extension and start answering."
              : "Access your dashboard and manage your account."}
          </p>
        </div>

        <div className="p-8 rounded-2xl bg-white/[0.02] border border-white/5">
          <button
            onClick={() => signIn("google", { callbackUrl: source === "extension" ? `/login?source=extension` : "/dashboard" })}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl bg-white text-gray-900 font-semibold hover:bg-gray-100 transition-colors"
          >
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continue with Google
          </button>

          <p className="text-xs text-gray-500 text-center mt-4">
            By signing in, you agree to our{" "}
            <a href="/privacy" className="text-purple-400 hover:underline">
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/10 border-t-purple-500 rounded-full animate-spin"></div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
