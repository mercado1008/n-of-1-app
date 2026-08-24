# My Formulas — Website Integration Guide

**For:** Website developer (nof1script.com.au)  
**What this does:** When a practitioner saves a completed formula in the Protocol Translator app, it automatically appears on their "My Formulas" page on the Shopify website.  
**Estimated setup time:** 2–4 hours

---

## How it works (big picture)

```
Protocol Translator app  →  Shopify Admin API  →  Shopify Metaobjects
     (this app)                (server-to-server)      (stored in Shopify)
                                                              ↓
                                               "My Formulas" Shopify page
                                                  (reads Metaobjects)
```

The Protocol Translator app is already built. When a practitioner saves a formula, it calls the Shopify Admin API directly (server-side, secure) and creates a **Metaobject** entry in Shopify. Your job is to:

1. Create the Metaobject type definition in Shopify (one-time setup, ~20 min)
2. Add the two environment variables to the app (2 min)
3. Build the "My Formulas" Shopify page that reads and displays those Metaobjects (~2–3 hours)

---

## Step 1 — Create the Metaobject type in Shopify

In your Shopify admin, go to **Settings → Custom data → Metaobjects → Add definition**.

| Setting | Value |
|---|---|
| Name | `N of 1 Formula` |
| API identifier (type) | `nof1_formula` |
| Storefront access | ✅ Enabled (so the Storefront API can read them) |

Add these fields to the definition:

| Field name | API key | Type | Notes |
|---|---|---|---|
| Formula name | `formula_name` | Single line text | Required |
| Practitioner email | `practitioner_email` | Single line text | Used to filter per-customer |
| Pod granules | `pod_granules` | Integer | e.g. 650 |
| Pod fill % | `pod_fill_percentage` | Decimal | e.g. 90.3 |
| Created at | `created_at` | Date and time | ISO 8601 string |
| Formula JSON | `formula_json` | JSON | Full ingredient + source data (see spec below) |

Save the definition.

---

## Step 2 — Add environment variables to the Protocol Translator

Edit `.env.local` on the app server (or add to Vercel environment variables):

```
SHOPIFY_SHOP_DOMAIN=nof1script.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxxxxxxx
```

**How to get the Admin API token:**
1. In Shopify admin → **Settings → Apps and sales channels → Develop apps**
2. Create a new app called "N of 1 Formula Export"
3. Under **Configuration**, grant the scope: `write_metaobjects` and `read_metaobjects`
4. Under **API credentials**, install the app and copy the **Admin API access token**

That's all the app setup needed. The Protocol Translator will now push formulas to Shopify automatically when practitioners save them.

---

## Step 3 — Build the "My Formulas" Shopify page

### 3a. How formulas are filtered per practitioner

Each saved formula includes the practitioner's `practitioner_email`. When the practitioner is logged into the Shopify website, you can get their email from the Liquid `customer` object:

```liquid
{% if customer %}
  {% assign practitioner_email = customer.email %}
{% endif %}
```

You then filter Metaobjects where `practitioner_email` matches this value.

### 3b. Querying Metaobjects — Storefront API (GraphQL)

Use the Shopify **Storefront API** from your theme's JavaScript (or a Hydrogen/Remix frontend). This requires a Storefront API access token — create one under **Settings → Apps → Develop apps → Storefront API integration**.

```graphql
query GetMyFormulas($practitionerEmail: String!) {
  metaobjects(type: "nof1_formula", first: 50) {
    edges {
      node {
        id
        handle
        fields {
          key
          value
        }
      }
    }
  }
}
```

> **Note:** The Storefront API doesn't support filtering Metaobjects by field value directly. Fetch all `nof1_formula` metaobjects and filter client-side by `practitioner_email`. For large datasets, use the Admin API instead (requires a custom app proxy — see section 3d below).

**Client-side filtering example (JavaScript):**

```javascript
async function getMyFormulas(practitionerEmail) {
  const response = await fetch('/api/2024-10/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': 'your-storefront-token',
    },
    body: JSON.stringify({
      query: `
        query {
          metaobjects(type: "nof1_formula", first: 50) {
            edges {
              node {
                id
                handle
                fields { key value }
              }
            }
          }
        }
      `,
    }),
  });

  const data = await response.json();
  const all = data.data.metaobjects.edges.map(({ node }) => {
    // Convert the fields array into a plain object
    const fields = Object.fromEntries(node.fields.map((f) => [f.key, f.value]));
    return { id: node.id, handle: node.handle, ...fields };
  });

  // Filter to this practitioner's formulas only
  return all.filter((f) => f.practitioner_email === practitionerEmail);
}
```

### 3c. Rendering a formula card

Each Metaobject has these fields after parsing:

```javascript
{
  id: "gid://shopify/Metaobject/...",
  handle: "nof1-formula-...",
  formula_name: "Patient ABC — Aug 2026 Protocol",
  practitioner_email: "dr@clinic.com.au",
  pod_granules: "650",
  pod_fill_percentage: "90.3",
  created_at: "2026-08-17T04:30:00.000Z",
  formula_json: "{...}"  // parse with JSON.parse()
}
```

The `formula_json` field, once parsed, has this shape:

```json
{
  "ingredients": [
    {
      "name": "Magnesium (elemental)",
      "dose": 150.0,
      "unit": "mg",
      "granules": 30,
      "section": "direct",
      "tier": "DIRECT"
    },
    {
      "name": "Levomefolic acid",
      "dose": 0.4,
      "unit": "mg",
      "granules": 20,
      "section": "class_substitute"
    },
    {
      "name": "Berberine HCL (Indian Barberry)",
      "dose": 500.0,
      "unit": "mg",
      "granules": 40,
      "section": "nof1_addition"
    }
  ],
  "purchase_separately": [
    {
      "name": "Omega-3 (EPA/DHA)",
      "total_dose": 2000,
      "unit": "mg"
    }
  ],
  "source_products": [
    {
      "artg_id": "123456",
      "product_name": "Metagenics UltraFlora",
      "sponsor": "Metagenics Australia",
      "units_per_day": 2
    }
  ]
}
```

**Section meanings:**
- `direct` — ingredient matched directly from the patient's current products
- `class_substitute` — therapeutically equivalent substitute confirmed by the practitioner
- `nof1_addition` — N of 1 exclusive ingredient added by the practitioner

**Example Liquid template for a formula card:**

```liquid
{% comment %} Loop over the formulas array (loaded via JS/AJAX) {% endcomment %}
<div class="formula-card">
  <div class="formula-card__header">
    <h3>{{ formula.formula_name }}</h3>
    <span class="formula-card__date">{{ formula.created_at | date: "%d %b %Y" }}</span>
    <span class="formula-card__pod">{{ formula.pod_granules }} / 720 granules ({{ formula.pod_fill_percentage }}%)</span>
  </div>

  <table class="formula-card__ingredients">
    <thead>
      <tr>
        <th>Ingredient</th>
        <th>Daily dose</th>
        <th>Granules</th>
      </tr>
    </thead>
    <tbody>
      {% for ingredient in formula_json.ingredients %}
      <tr>
        <td>{{ ingredient.name }}</td>
        <td>{{ ingredient.dose }} {{ ingredient.unit }}</td>
        <td>{{ ingredient.granules }}</td>
      </tr>
      {% endfor %}
    </tbody>
  </table>

  {% if formula_json.purchase_separately.size > 0 %}
  <div class="formula-card__separately">
    <strong>Source separately:</strong>
    {% for item in formula_json.purchase_separately %}
      {{ item.name }} {{ item.total_dose }}{{ item.unit }}{% unless forloop.last %},{% endunless %}
    {% endfor %}
  </div>
  {% endif %}
</div>
```

### 3d. Alternative — App Proxy (recommended for production)

If you want server-side filtering (more secure, faster for large practitioners), create a **Shopify App Proxy** endpoint:

1. In Shopify admin → the "N of 1 Formula Export" app → **Configuration → App proxy**
2. Set the subpath to `/apps/nof1-formulas`
3. Point it to a small serverless function (Vercel, Cloudflare Workers, or the Protocol Translator app itself at `GET /api/formulas?email=xxx`)
4. The function calls the Shopify Admin API, filters by email, and returns JSON
5. The Shopify theme calls `/apps/nof1-formulas?email={{ customer.email }}` — Shopify validates the request is coming from the right store

This is optional for an internal team but good practice before going to many practitioners.

---

## Full payload spec (for reference)

This is the exact JSON body that the Protocol Translator sends to the `/api/formula-export` route. You don't need to process this directly — it's already being parsed server-side before being stored in Shopify. Included here for completeness.

```typescript
{
  schema_version: "1.0",
  formula_name: string,
  practitioner_email: string,
  created_at: string,           // ISO 8601
  pod_granules: number,
  pod_capacity: 720,
  pod_fill_percentage: number,  // e.g. 90.3
  ingredients: Array<{
    name: string,
    dose: number,
    unit: string,               // "mg" | "mcg" | "IU"
    granules: number,
    section: "direct" | "class_substitute" | "nof1_addition",
    tier?: string               // "DIRECT" | "FORM_SUBSTITUTION" (direct only)
  }>,
  purchase_separately: Array<{
    name: string,
    total_dose: number,
    unit: string
  }>,
  source_products: Array<{
    artg_id: string,
    product_name: string,
    sponsor: string,
    units_per_day: number
  }>
}
```

---

## Testing the integration

1. Set the two environment variables in `.env.local`
2. Open the Protocol Translator, build a formula, and click "Save to My Formulas"
3. In Shopify admin → **Content → Metaobjects → N of 1 Formula** — you should see the new entry
4. Check all fields are populated correctly, especially `formula_json`
5. Build the "My Formulas" page, query via Storefront API, and verify the formula card renders

If the environment variables are not set, the app logs the payload to the server console and returns success — useful for local development without a Shopify account.

---

## Questions?

Contact Neal at neal@nof1script.com.au. The Protocol Translator app repository has full source code for the export route at `app/api/formula-export/route.ts`.
