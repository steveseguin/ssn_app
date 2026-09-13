# eBay Live setup and blank windows

Use a public `/ebaylive/events/EVENT_ID` link (optionally ending in `/chat` or
`/stream`), or a `/ebaylive/sellers/SELLER_ID` link to choose a live event. A login
session token or seller ID is not an event ID.

SSApp verifies direct event links before saving and verifies saved events again
before activation. A missing event is rejected with an error instead of opening
an empty black chat page. A failed lookup is reported separately from a missing
event and can be retried. Recorded events remain supported; an existing event is
not necessarily live or currently receiving messages.

Sign-in preserves the source's regional marketplace, including `ebay.ca`,
`ebay.co.uk`, `ebay.com.au`, and `ebay.com.hk`. Canadian French (`cafr.ebay.ca`)
and Belgian language hosts (`befr.ebay.be`, `benl.ebay.be`) are preserved. Bare
marketplace domains and `www` language aliases normalize to capture-supported
hosts. Explicit sign-in URL overrides still take precedence. Browser session
mapping and other platforms' behavior are unchanged.

The supported domains follow the existing SSN eBay capture manifest. eBay's
[regional marketplace links](https://www.ebay.com/help/account/regulatory/regulatory-hub?id=5393)
include Canada, Australia, the UK, European sites and Greater China
(`ebay.com.hk`). `ebaychina.com` has not been verified as an eBay Live marketplace
and is not accepted. A country site existing does not imply that local sellers
can host eBay Live events there.

## Validation, 2026-09-13

- `node tests/electron/ebay-setup-e2e.js`: isolated actual SSApp workflow with
  local eBay fixtures; invalid/malformed responses, retry, canceled requests,
  saved-source activation, regional sign-in windows, all 21 manifest hosts,
  seller selection and persistence across a process restart.
- `node tests/ebay-live-capture.e2e.cjs` in `social_stream`: actual SSApp capture
  windows with local auction/chat fixtures, including reload and duplicate checks.
- Read-only real-site checks in an isolated Windows SSApp profile: event lookup
  on US, UK, Australia, Canada, France, Germany and Italy sites; nonexistent-event
  rejection; UK sign-in page and recorded chat loading. No credentials, chat
  messages or bids submitted. This does not certify Mac/Linux rendering, paid
  actions, or every country's login flow.
- The UK homepage loaded successfully once, but subsequent sign-in checks also
  encountered eBay's own "Something went wrong on our end" page. The corrected
  destination was confirmed; the URL fix cannot prevent upstream site errors.

These are desktop app changes and require an updated app build. Changing the
Social Stream main/beta source selection alone does not update the bundled UI.
