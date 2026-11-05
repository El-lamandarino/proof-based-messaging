// Vercel serverless function: the only place that talks to Gemini.
// The API key is read from the GEMINI_API_KEY environment variable set in Vercel.
// The browser never sees the key.

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Used automatically when the main model is overloaded. Override in Vercel with GEMINI_FALLBACK_MODEL.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
const BUSY = new Set([500, 502, 503, 504]); // temporary errors on Google's side: worth retrying
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_INPUT_CHARS = 120000;

const PROMPTS = {
  themes: ({ product, reviews }) => `You are a voice-of-customer analyst for a B2B product marketing team.

INPUT: customer reviews of ${product}, one per line, in the format:
id | source | date | reviewer_role | company_size | text

TASK: Find the recurring themes in what customers say. Use these theme types:
- "value": a benefit or outcome customers get
- "pain": a problem they had before or a frustration with the product
- "objection": a reason to hesitate or a concern a prospect might raise (price, control, transparency, fit)
- "use_case": what they use the product for
- "trigger": what made them look for a solution

RULES:
1. A theme must appear in at least 2 different reviews. Ignore one-off comments.
2. Quotes must be copied word for word from the review text. Never fix, shorten mid-sentence or paraphrase a quote. Each quote max 25 words; pick the most specific part of the sentence.
3. If a review is not in English, quote it in the original language and add an English translation in "quote_en".
4. Tag every quote with its review id. Give 2 to 4 quotes per theme.
5. Use the customers' own words in theme labels where possible (e.g. "black box decisions", not "limited explainability").
6. Do not judge or soften negative themes. Objections are as important as praise.
7. Return 8 to 15 themes, ordered from most to least widespread.
8. Then write 3 to 5 key findings a PMM would brief to leadership: what the reviews say about why customers buy, what holds them back, and anything that differs by buyer role. Each finding cites its theme ids. No numbers unless they appear in quotes. Do not use em dashes.

OUTPUT: JSON only:
{"themes":[{"id":"T1","type":"value|pain|objection|use_case|trigger","label":"short label in customer language","summary":"one sentence","review_ids":["R003"],"quotes":[{"review_id":"R003","quote":"exact words","quote_en":null}]}],
"findings":[{"headline":"max 12 words","detail":"max 40 words","theme_ids":["T1","T4"]}]}

REVIEWS:
${reviews}`,

  messaging: ({ product, themes, personas }) => `You are a senior product marketing manager writing messaging for ${product}.

INPUT:
1. Themes extracted from real customer reviews. Each theme has an id, a type, the number of reviews that mention it ("review_count"), how many are from 2025 or later ("recent_count"), how many come from each persona ("persona_counts"), and verified quotes.
2. Personas defined by the PMM: name, role in the deal, and what they care about.

TASK: Write messaging and sales assets built ONLY on these themes.

RULES:
1. Every item must cite the theme ids that support it in "theme_ids". If no theme supports a claim, do not write the claim.
2. Prefer themes with higher review_count and recent_count. Mention a theme with review_count below 3 only as a secondary point.
3. Use numbers only if they appear in a quote. Never invent statistics, percentages or customer names.
4. Use the customers' language from the quotes. Avoid generic marketing words (e.g. "revolutionary", "seamless", "cutting-edge", "unlock") unless customers used them.
5. Objection responses must be honest: acknowledge the concern, then answer with evidence from "value" themes. Do not deny a weakness that customers report.
6. Do not name competitors.
7. Do not use em dashes. Use commas, colons or periods.
8. Write one message for EACH buyer persona provided, built from themes where that persona has persona_counts above 0, plus shared themes. If a persona has fewer than 3 supporting reviews, say so in "evidence_note".
9. Write an SDR pitch: the version of this messaging an SDR must remember after one read and say naturally on a first call. Plain spoken words, no jargon or acronyms a prospect would not use, no stacked adjectives. It must say the same thing as the value proposition, not a new claim.
10. Write the positioning as a senior PMM would, in this order, using only the themes:
   a. Competitive alternative: what customers used or would use instead (from "trigger" and "pain" themes), e.g. manual review, in-house rules, a fragmented setup. Never a named competitor.
   b. Unique attribute: the one thing the product does that this alternative cannot. It must be differentiating, not table stakes. Claims every vendor in the category makes (e.g. "accurate", "AI-powered", "easy to use", "great support") are table stakes: leave them out.
   c. Value: the outcome that attribute delivers, framed in business terms (revenue, cost, time), from "value" themes with the highest review_count and recent_count.
   d. Target: the segment that cares most and is best served. Use reviewer company sizes and roles; exclude segments that raise fit or cost objections.
   e. Category: a market category buyers already recognize and budget for.
   Then write ONE sentence, max 30 words:
   "For [target] [need], [product] is the [category] that [value by mechanism], unlike [alternative]."
   - for_who: max 6 words, a specific segment, never "businesses" or "companies".
   - need: max 8 words, starts with "who" or a verb ending in -ing (e.g. "losing revenue to false declines"), in customer language.
   - category: max 4 words.
   - key_benefit: max 14 words, ONE benefit plus the mechanism that makes it possible (e.g. "approves more good orders by carrying the fraud risk itself"). No "and" lists.
   - unlike: max 5 words, the generic alternative from step a.
   Rules: no hype adjectives ("leading", "innovative", "powerful", "best-in-class"); no absolute words ("every", "always", "guaranteed", "100%") unless quotes use the same strength; no weakness customers report may be implied as a strength (e.g. do not claim transparency if customers call decisions a black box). Proof points belong in the pillars.
11. Give every item the id shown in the schema (PS, VP, P1-P3, PE1.., O1.., EM, SD).

OUTPUT: JSON only:
{"positioning":{"id":"PS","for_who":"max 6 words","need":"max 8 words, starts with who or an -ing verb","category":"max 4 words","key_benefit":"max 14 words, one benefit plus mechanism","unlike":"max 5 words","theme_ids":["T1"],
  "rationale":{"alternative":"what customers moved away from, and why it matters (max 25 words)","unique_attribute":"what the alternative cannot do (max 25 words)","target":"why this segment, and who is excluded (max 25 words)","left_out":["claim deliberately excluded: reason (table stakes, overclaim or customer-reported weakness)"]}},
"value_prop":{"id":"VP","text":"one or two sentences","theme_ids":["T1"]},
"pillars":[{"id":"P1","headline":"max 8 words","body":"max 40 words","theme_ids":["T2"]}],
"personas":[{"id":"PE1","persona":"persona name as provided","top_pain":"...","message":"max 40 words","evidence_note":null,"theme_ids":["T4"]}],
"objections":[{"id":"O1","objection":"how a prospect would say it","response":"max 50 words","theme_ids":["T6","T2"]}],
"outreach_email":{"id":"EM","persona":"which persona it targets","subject":"max 7 words","body":"max 90 words, one question as the call to action","theme_ids":["T1"]},
"sdr_pitch":{"id":"SD","one_liner":"max 15 words","talk_track":["max 12 words","max 12 words","max 12 words"],"theme_ids":["T1"]}}
Write exactly 3 pillars and 3 to 5 objections.

PERSONAS:
${JSON.stringify(personas)}

THEMES:
${JSON.stringify(themes)}`,

  proof: ({ messaging, themes }) => `You are a strict fact-checker reviewing marketing claims against customer evidence.

INPUT:
1. Messaging JSON. Each item has an id, text and the theme_ids it claims as support.
2. Themes JSON with the exact customer quotes behind each theme.

TASK: Check every claim in the messaging. Split long items into separate claims (one factual statement each). Skip pure questions and calls to action.

Verdicts:
- "supported": the cited quotes clearly back the claim, from at least 2 reviews
- "weak": quotes back part of the claim, it rests on 1 review only, or the wording is stronger than the evidence (e.g. "eliminates" when customers say "reduces")
- "unsupported": no cited quote backs it, or the cited theme does not match the claim

RULES:
1. Judge only against the quotes provided. Do not use outside knowledge about the product.
2. Flag absolute words ("always", "never", "eliminate", "100%", "guaranteed") unless a quote uses the same strength.
3. For weak and unsupported claims, suggest a rewrite that the evidence does support. Do not use em dashes.
4. Be strict. A weak verdict is more useful than a generous one.

SDR CHECK: Also judge the SDR pitch (id SD) as a sales coach would. Imagine an SDR who read it once an hour ago and must now say it to a prospect on a cold call.
- "recall": 1 to 5, how easily they would remember it word for word or close to it.
- "say_it": 1 to 5, how natural it sounds spoken aloud to a prospect.
- "jargon": words or phrases a prospect might not understand or an SDR would stumble on.
- "matches_messaging": true if it carries the same core promise as the value proposition.
- "verdict": "pass" only if recall and say_it are both 4 or higher and matches_messaging is true, else "revise".
- "simpler_version": if revise, a version that would pass. Do not use em dashes.

OUTPUT: JSON only:
{"claims":[{"item_id":"VP","claim":"the single statement checked","verdict":"supported|weak|unsupported","reason":"one sentence","best_quote":{"review_id":"R012","quote":"exact words"},"suggested_rewrite":null}],
"sdr_check":{"recall":4,"say_it":3,"jargon":["..."],"matches_messaging":true,"verdict":"pass|revise","note":"one sentence","simpler_version":null}}

MESSAGING:
${JSON.stringify(messaging)}

THEMES:
${JSON.stringify(themes)}`,
};

const TEMPERATURE = { themes: 0.2, messaging: 0.5, proof: 0.2 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel environment variables." });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { step, input } = body;
  if (!PROMPTS[step] || !input) {
    res.status(400).json({ error: "Send { step: 'themes' | 'messaging' | 'proof', input: {...} }." });
    return;
  }

  const prompt = PROMPTS[step](input);
  if (prompt.length > MAX_INPUT_CHARS) {
    res.status(413).json({ error: "Too much text for one run. Use fewer reviews (about 80 or less)." });
    return;
  }

  // Try the main model up to 3 times (waits 2s, then 5s), then the fallback model twice.
  const attempts = [
    { model: MODEL, wait: 0 }, { model: MODEL, wait: 2000 }, { model: MODEL, wait: 5000 },
    { model: FALLBACK_MODEL, wait: 0 }, { model: FALLBACK_MODEL, wait: 3000 },
  ].filter((a, i) => i < 3 || a.model !== MODEL); // skip the fallback if it is the same model

  let lastError = "Gemini request failed.";
  for (const { model, wait } of attempts) {
    if (wait) await sleep(wait);
    let r, data;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: TEMPERATURE[step], responseMimeType: "application/json" },
        }),
      });
      data = await r.json().catch(() => ({}));
    } catch (e) {
      lastError = "Could not reach Gemini: " + e.message;
      continue; // network hiccup: try the next attempt
    }

    if (!r.ok) {
      lastError = data?.error?.message || `Gemini request failed (${r.status}).`;
      if (r.status === 429) {
        res.status(429).json({ error: "Free-tier limit reached. Wait a minute and run again." });
        return;
      }
      if (BUSY.has(r.status) || r.status === 404) continue; // busy, or model name not available: try next
      res.status(502).json({ error: lastError });
      return;
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    try {
      const parsed = JSON.parse(text.replace(/^```json\s*|```\s*$/g, ""));
      res.status(200).json({ result: parsed, model });
      return;
    } catch {
      lastError = "The AI returned invalid JSON.";
      continue; // retry once more rather than failing the whole run
    }
  }
  res.status(503).json({
    error: "Google's AI servers are busy right now. Wait a few minutes and click Analyze reviews again. (" + lastError + ")",
  });
}
