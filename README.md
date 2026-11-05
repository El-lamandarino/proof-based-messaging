# Proof-Based Messaging

**Live app:** _add your Vercel link here_

Turns customer reviews into messaging and sales assets (value proposition, pillars, persona messages, objection handling, outreach email), and marks every claim the evidence can't back.

## The problem

Product marketers own positioning and messaging, but messaging is often built on opinions and anecdotes rather than systematic customer evidence. Sales doesn't trust what it can't verify, so much of the content goes unused. Existing tools (G2's vendor dashboards, VoC platforms) summarize what customers say. This app covers the next step: what *we* should say, and whether we can prove it.

## How it works

| Step | What happens | Done by |
|---|---|---|
| 1. Map personas | Each reviewer's job title is matched to a buying committee the PMM defines. Unknown roles still count toward themes. | Code |
| 2. Find themes | Values, pains, objections, use cases and triggers, each with word-for-word quotes and review IDs. | AI |
| 2b. Verify | Code counts reviews per theme, splits recent (2025+) from older, counts reviews per persona, and checks that every quote really exists in the source text. | Code |
| 3. Write messaging | Built only from verified themes. Every line cites its themes. No invented numbers, no competitor names. | AI |
| 4. Proof check | A separate, strict pass splits the copy into single claims and rates each as supported, weak or unsupported, with a rewrite for weak ones. | AI |

**Design principle:** AI handles language judgment (grouping, writing, checking). Code handles anything that has to be exactly right (counting, dates, quote verification), because LLMs are unreliable at counting and tend to paraphrase quotes.

## Dataset (example run)

75 public reviews of Riskified from G2 (40), TrustRadius (20) and Capterra (15), 2018 to 2026, with 37 from 2025 or later. Reviewer names and employers were removed. The public page shows only short excerpts, credited to their source.

## Results

_Fill in after the first runs:_
- Claims supported on first run: __%
- Change after prompt tuning: __
- Quotes verified word for word: __ of __

## Stack

- Front end: plain HTML, CSS and JavaScript (`index.html`, `app.js`)
- AI: Gemini API, called only from a Vercel serverless function (`api/analyze.js`), so the API key never reaches the browser
- Hosting: Vercel Hobby plan, deployed from this GitHub repo

## Run your own

1. Fork this repo and import it into Vercel.
2. Add `GEMINI_API_KEY` in Vercel → Project → Settings → Environment Variables. Optional: `GEMINI_MODEL` to choose a model.
3. Open the app, upload a CSV with columns `id, source, date, reviewer_role, company_size, text`, and click **Analyze reviews**.
4. Click **Export results as JSON** and save it as `data/example.json` to show that run to visitors by default.

---
Built by Elina Kirilenko.
