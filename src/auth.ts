import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import type { TokenSet } from "@auth/core/types";

const requiredVariables = ["AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"] as const;
export const missingAuthVariables = requiredVariables.filter((name) => !process.env[name]?.trim());
const secretIsValid = (process.env.AUTH_SECRET?.trim().length || 0) >= 32;
export const authConfigured = missingAuthVariables.length === 0 && secretIsValid;
export const authSetupMessage = missingAuthVariables.length
  ? `Set ${missingAuthVariables.join(", ")} on the server to enable GitHub sign-in.`
  : !secretIsValid ? "Set AUTH_SECRET to a random value of at least 32 characters." : "";

export function safeCallbackPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return "/";
    const parsed = new URL(value, "https://readlay.invalid");
    const normalisedPath = decodeURIComponent(parsed.pathname);
    if (parsed.origin !== "https://readlay.invalid" || normalisedPath.startsWith("//") || normalisedPath === "/sign-in" || normalisedPath.startsWith("/api/auth")) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: Boolean(process.env.AUTH_URL) || process.env.VERCEL === "1" || process.env.NODE_ENV !== "production",
  providers: authConfigured ? [GitHub({
    clientId: process.env.AUTH_GITHUB_ID,
    clientSecret: process.env.AUTH_GITHUB_SECRET,
    authorization: { params: { scope: "read:user" } },
    userinfo: {
      url: "https://api.github.com/user",
      async request({ tokens }: { tokens: TokenSet }) {
        if (!tokens.access_token) throw new Error("GitHub did not return an access token.");
        const response = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "Readlay" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("GitHub profile could not be loaded.");
        return response.json();
      },
    },
    profile(profile) {
      return { id: String(profile.id), name: profile.name || profile.login, email: null, image: profile.avatar_url };
    },
  })] : [],
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  callbacks: {
    jwt({ token, account, profile }) {
      if (account?.provider === "github") {
        token.sub = account.providerAccountId;
        if (typeof profile?.login === "string") token.login = profile.login;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub || "";
      session.user.login = typeof token.login === "string" ? token.login : undefined;
      return session;
    },
    redirect({ url, baseUrl }) {
      try {
        const target = new URL(url, baseUrl);
        if (target.origin !== new URL(baseUrl).origin) return baseUrl;
        return new URL(safeCallbackPath(`${target.pathname}${target.search}${target.hash}`), baseUrl).href;
      } catch {
        return baseUrl;
      }
    },
  },
});
