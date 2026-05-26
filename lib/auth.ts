import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma) as any,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: {
    strategy: "database",
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  debug: true,
  logger: {
    error(code, ...message) {
      console.error("[AUTH ERROR]", code, JSON.stringify(message));
    },
    warn(code, ...message) {
      console.warn("[AUTH WARN]", code, ...message);
    },
  },
});
