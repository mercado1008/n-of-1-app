/**
 * app/api/formula-export/route.ts
 *
 * Receives a completed Protocol Translator formula from the browser, then
 * persists it to Shopify as a Metaobject (type: nof1_formula).
 *
 * Environment variables required (add to .env.local and Vercel):
 *   SHOPIFY_SHOP_DOMAIN        — e.g. nof1script.myshopify.com
 *   SHOPIFY_ADMIN_API_TOKEN    — Admin API token with write_metaobjects scope
 *
 * If either variable is absent the route returns 200 with mode:"dev_no_shopify"
 * so the UI can show "saved" during local development without Shopify configured.
 *
 * Shopify Metaobject type  : nof1_formula  (must be created first — see docs/)
 * Shopify API version used : 2025-01
 */

import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormulaIngredient {
  name: string;
  dose: number;
  unit: string;
  granules: number;
  section: 'direct' | 'class_substitute' | 'nof1_addition';
  /** DIRECT | FORM_SUBSTITUTION — only present for 'direct' section items. */
  tier?: string;
}

export interface FormulaExportPayload {
  schema_version: '1.0';
  formula_name: string;
  /** Practitioner's Shopify account email — used to associate with a customer. */
  practitioner_email: string;
  created_at: string; // ISO 8601
  pod_granules: number;
  pod_capacity: 720;
  pod_fill_percentage: number;
  ingredients: FormulaIngredient[];
  purchase_separately: Array<{ name: string; total_dose: number; unit: string }>;
  source_products: Array<{
    artg_id: string;
    product_name: string;
    sponsor: string;
    units_per_day: number;
  }>;
}

// ---------------------------------------------------------------------------
// Shopify GraphQL mutation
// ---------------------------------------------------------------------------

const METAOBJECT_CREATE = /* graphql */ `
  mutation CreateNof1Formula($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        handle
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function createShopifyMetaobject(
  payload: FormulaExportPayload,
  shopDomain: string,
  adminToken: string,
): Promise<{ id: string; handle: string }> {
  const endpoint = `https://${shopDomain}/admin/api/2025-01/graphql.json`;

  const variables = {
    metaobject: {
      type: 'nof1_formula',
      fields: [
        { key: 'formula_name',        value: payload.formula_name },
        { key: 'practitioner_email',  value: payload.practitioner_email },
        { key: 'pod_granules',        value: String(payload.pod_granules) },
        { key: 'pod_fill_percentage', value: String(payload.pod_fill_percentage) },
        { key: 'created_at',          value: payload.created_at },
        // Store the full ingredient + source data as a JSON blob so the
        // website developer can display whatever level of detail they need.
        {
          key: 'formula_json',
          value: JSON.stringify({
            ingredients:        payload.ingredients,
            purchase_separately: payload.purchase_separately,
            source_products:    payload.source_products,
          }),
        },
      ],
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({ query: METAOBJECT_CREATE, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string; handle: string };
        userErrors: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }

  const result = json.data?.metaobjectCreate;
  if (result?.userErrors.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  if (!result?.metaobject) {
    throw new Error('Shopify returned no metaobject and no errors — check the type definition exists.');
  }

  return result.metaobject;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let payload: FormulaExportPayload;

  try {
    payload = (await req.json()) as FormulaExportPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Basic validation
  if (!payload.formula_name?.trim()) {
    return NextResponse.json({ error: 'formula_name is required' }, { status: 400 });
  }
  if (!payload.practitioner_email?.trim()) {
    return NextResponse.json({ error: 'practitioner_email is required' }, { status: 400 });
  }

  const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN;
  const adminToken  = process.env.SHOPIFY_ADMIN_API_TOKEN;

  // Dev mode: no Shopify configured — succeed silently so the UI works locally.
  if (!shopDomain || !adminToken) {
    console.log('[formula-export] DEV MODE — no Shopify env vars, skipping upload.');
    console.log('[formula-export] Payload:', JSON.stringify(payload, null, 2));
    return NextResponse.json({ ok: true, mode: 'dev_no_shopify', formula_name: payload.formula_name });
  }

  try {
    const metaobject = await createShopifyMetaobject(payload, shopDomain, adminToken);
    return NextResponse.json({ ok: true, shopify_id: metaobject.id, handle: metaobject.handle });
  } catch (err) {
    console.error('[formula-export] Shopify error:', err);
    return NextResponse.json(
      { error: `Failed to save to Shopify: ${String(err)}` },
      { status: 502 },
    );
  }
}
