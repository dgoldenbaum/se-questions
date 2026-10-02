# SE Question Finder

Search the technical questions clients have asked the SE team (from Gong calls and emails), see who answered them and how, and reuse the reference answers. It grew out of the *SE Technical Question Catalog* page and uses the same data shape.

## Run it

```sh
npm start            # http://localhost:8080
npm test             # query engine tests
npm run query -- 'status:deferred topic:security'
npm run query -- --similar "Do you support Okta SSO?"
```

It needs Node 18 or later and has no dependencies. The site is fully static, so any static host works, including GitHub Pages.

## Data

The app loads `data/questions.json`. If that file is missing, it falls back to `data/questions.sample.json`, which uses made-up accounts and shows a banner saying so. To use the real catalog:

- **Shared copy:** commit the export as `data/questions.json`.
- **Just for you:** click **Import** and pick a JSON or CSV file. It's kept in your browser until you click *Go back to the shared data*.

Each question is a JSON object. Only `question` is required:

```json
{
  "id": "q123", "question": "Do you support SSO through Okta?", "account": "Acme Bank", "asker": "CISO",
  "category": "Security & compliance", "product": "Array+ Platform",
  "answeredBy": "Jane Doe (SE)", "answererRole": "SE | AE | Product/Eng",
  "status": "Answered | Partial | Deferred", "needsProduct": false, "date": "2026-05-01",
  "sourceType": "call", "sourceUrl": "https://…gong.io/call?id=…", "sourceLabel": "Gong call",
  "note": "", "referenceAnswer": ""
}
```

The importer accepts a plain array, `{ "questions": [...] }`, or a database export shaped like `[{ "id", "data": {...} }]`. CSV headers can be field names or labels such as `Topic`, `Asked by`, `Answered by`, `Reference answer`, and `Gong link`.

Edits made in the app (reference answers, status changes, new questions) are saved in your browser. To share them, use **Export → Full dataset as JSON** and commit the file as `data/questions.json`.

## Query syntax

| Query | Meaning |
|---|---|
| `sso okta` | Words, ranked by relevance (BM25). Prefixes match (`encrypt` → encryption) and so do common synonyms (`sso` → SAML/Okta, `bureau` → Experian/Equifax/TransUnion) |
| `"data refresh"` | Exact phrase |
| `-mobile`, `-status:answered` | Exclude a word, phrase or filter |
| `account:acme` | Field contains a value. Fields: `account` `topic` `product` `status` `by` `asker` `role` `source` |
| `status:partial,deferred` | Comma = any of these values |
| `after:2026-05-01` `before:2026-07` `after:30d` | Date range. Relative units: `d` `w` `m` `y` |
| `has:answer` `has:link` `has:note` | Has a reference answer, a call link, or a note |
| `is:gap` `is:pe` `is:partial` | Training gap (not fully answered, or product/eng had to step in), or answered by product/eng |

If no question matches every word, results fall back to questions that match some of the words, and the page says so. Clicking a facet, a stat tile, or a topic bar edits the query, and the URL keeps the current query and selected question, so you can share a search as a link.

The detail panel lists **similar questions** by text similarity. As you type in **Add a question**, it suggests existing questions that look like duplicates.

## Layout

```
index.html            page shell
src/query.js          parser, index, ranking, similarity (shared by app and CLI)
src/app.js            UI
src/styles.css        styles (light and dark)
bin/query.mjs         CLI
scripts/serve.mjs     zero-dependency static server
data/                 questions.json (yours) and questions.sample.json
test/                 node:test suite for the query engine
```
