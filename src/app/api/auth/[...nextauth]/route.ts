import type { NextRequest } from "next/server";
import { authConfigured, handlers } from "@/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (authConfigured) return handlers.GET(request);
  const action = request.nextUrl.pathname.split("/").pop();
  const headers = { "Cache-Control": "no-store" };
  if (action === "session") return Response.json(null, { headers });
  if (action === "providers") return Response.json({}, { headers });
  return Response.json({ error: "GitHub sign-in has not been configured." }, { status: 503, headers });
}

export async function POST(request: NextRequest) {
  if (authConfigured) return handlers.POST(request);
  return Response.json({ error: "GitHub sign-in has not been configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
