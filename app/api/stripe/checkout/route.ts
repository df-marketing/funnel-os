import { createClient } from "@/lib/supabase/server";
import { createCheckoutSession } from "@/lib/stripe";
import { NextResponse } from "next/server";

/**
 * POST /api/stripe/checkout
 * Body: { priceId: string, successUrl?: string, cancelUrl?: string }
 *
 * Creates a Stripe Checkout Session for the authenticated user.
 * Respects Connect platform fee if STRIPE_PLATFORM_FEE_PERCENT is set.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { priceId, successUrl, cancelUrl } = body as {
      priceId: string;
      successUrl?: string;
      cancelUrl?: string;
    };

    if (!priceId) {
      return NextResponse.json({ error: "priceId is required" }, { status: 400 });
    }

    const origin = request.headers.get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

    // Look up existing Stripe customer ID if stored
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    const session = await createCheckoutSession({
      priceId,
      customerId: profile?.stripe_customer_id ?? undefined,
      userId: user.id,
      successUrl: successUrl ?? `${origin}/dashboard?checkout=success`,
      cancelUrl: cancelUrl ?? `${origin}/dashboard?checkout=canceled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
