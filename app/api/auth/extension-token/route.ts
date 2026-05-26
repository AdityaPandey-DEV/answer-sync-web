import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import crypto from "crypto";

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.email) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Generate a unique extension token
    const extensionToken = crypto.randomBytes(32).toString("hex");

    // Find the user and store the extension token
    const user = await prisma.user.update({
      where: { email: session.user.email },
      data: {
        // We'll use the session token field pattern — store it as a session
      },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        dailyCreditsUsed: true,
      },
    });

    // Create a session for the extension
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await prisma.session.create({
      data: {
        sessionToken: extensionToken,
        userId: user.id,
        expires,
      },
    });

    // Get admin settings for credit limit
    const adminSettings = await prisma.adminSettings.findUnique({
      where: { id: "global" },
    });

    return NextResponse.json({
      token: extensionToken,
      email: user.email,
      name: user.name,
      tier: user.tier,
      dailyCreditsUsed: user.dailyCreditsUsed,
      dailyCreditLimit: adminSettings?.dailyCreditLimit || 20,
    });
  } catch (error: any) {
    console.error("Extension token error:", error);
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}
