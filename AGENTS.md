# Project conventions

## Stack
- **Next.js 15** App Router, React 19, TypeScript strict
- **Tailwind v4** — CSS-first config in `app/globals.css` (no `tailwind.config.ts`)
- **Supabase** via `@supabase/ssr` (cookie-based sessions)
- **Bun** package manager

## Supabase client patterns
| Context | Import from |
|---|---|
| Client component | `lib/supabase/client.ts` |
| Server component / Route handler / Server action | `lib/supabase/server.ts` |
| Middleware | `lib/supabase/middleware.ts` |

- **Never** expose `SUPABASE_SERVICE_ROLE_KEY` to the browser
- **Never** use deprecated `@supabase/auth-helpers-nextjs`
- Server components are default — add `"use client"` only when needed
- Use Server Actions for mutations (prefer over `/api` routes)

## Path aliases
`@/*` → repo root

## Stripe payments

### Two modes — controlled by env vars only, no code changes
- **Standalone:** set `STRIPE_SECRET_KEY`. Platform vars are empty.
- **Platform (via Vibe Launchpad):** `STRIPE_CONNECT_ACCOUNT_ID` + `STRIPE_PLATFORM_FEE_PERCENT` are injected at provisioning time. Platform takes a cut automatically.

### API routes
| Route | Method | Purpose |
|---|---|---|
| `/api/stripe/checkout` | POST `{ priceId }` | Create Checkout Session, returns `{ url }` |
| `/api/stripe/portal` | POST | Billing portal for subscription management |
| `/api/stripe/webhooks` | POST | Stripe webhook handler (verify + process events) |

### Required Supabase tables
Run in Supabase SQL Editor before using payments:
```sql
-- Store Stripe customer ID on profiles
alter table profiles add column if not exists stripe_customer_id text;

-- Subscriptions (updated by webhook)
create table subscriptions (
  id text primary key,
  user_id uuid references auth.users not null,
  stripe_customer_id text not null,
  status text not null,
  price_id text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table subscriptions enable row level security;
create policy "Users see own subscription"
  on subscriptions for select using (auth.uid() = user_id);

-- One-time purchases
create table purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  stripe_customer_id text,
  stripe_session_id text,
  amount_total integer,
  status text,
  created_at timestamptz default now()
);
alter table purchases enable row level security;
create policy "Users see own purchases"
  on purchases for select using (auth.uid() = user_id);
```

### Local webhook testing
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhooks
```

### Usage in a Server Action
```typescript
"use server";
import { redirect } from "next/navigation";

export async function subscribe(priceId: string) {
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify({ priceId }),
  });
  const { url } = await res.json();
  redirect(url);
}
```

## gstack workflow
This repo uses [gstack](https://github.com/garrytan/gstack):
- **Plan:** `/office-hours` → `/autoplan`
- **Review:** `/review` before merging
- **Ship:** `/ship` (bumps version, opens PR)
- **Deploy:** `/land-and-deploy` after PR merge
- **QA:** `/qa <preview-url>` on every deploy
- **Security audit:** `/cso` before going public
