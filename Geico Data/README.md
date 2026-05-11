# GEICO Data Export

Source URL: https://www.geico.com/information/aboutinsurance/auto/
Unique URLs found on source page: 25
Cleaned web pages: 24
Skipped non-web URLs: 1

## Cleaning Logic

- Original noisy exports are backed up in `raw-pages/`.
- Cleaned exports are in `pages/`.
- The cleaner removes GEICO global header/menu/account navigation before the `Home >` breadcrumb.
- The cleaner removes common footer, quote, contact, quick-link, and sidebar navigation blocks after the article content.

## Semantic RAG

- The app chunks the cleaned files in `pages/` and builds a local OpenAI embedding cache at `semantic-index.json`.
- `semantic-index.json` is generated automatically on the first GEICO knowledge question and is ignored by git.
- If the cleaned source files change, the semantic index is rebuilt automatically.

## Cleaned Pages
- SAVED: https://www.geico.com/auto-insurance/ -> pages/01-www-geico-com-auto-insurance.txt (15031 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/full-coverage/ -> pages/02-www-geico-com-information-aboutinsurance-auto-full-coverage.txt (9679 chars)
- SAVED: https://www.geico.com/umbrella-insurance/ -> pages/03-www-geico-com-umbrella-insurance.txt (9618 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/med-pay/ -> pages/04-www-geico-com-information-aboutinsurance-auto-med-pay.txt (4957 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/pip/ -> pages/05-www-geico-com-information-aboutinsurance-auto-pip.txt (9611 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/uninsured-underinsured-motorist/ -> pages/06-www-geico-com-information-aboutinsurance-auto-uninsured-underinsured-motorist.txt (4774 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/collision-coverage/ -> pages/07-www-geico-com-information-aboutinsurance-auto-collision-coverage.txt (5715 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/comp-coverage/ -> pages/08-www-geico-com-information-aboutinsurance-auto-comp-coverage.txt (5825 chars)
- SAVED: https://www.geico.com/auto-insurance/emergency-road-service/ -> pages/09-www-geico-com-auto-insurance-emergency-road-service.txt (7294 chars)
- SAVED: https://www.geico.com/claims/claimsprocess/vehicle-rental/ -> pages/10-www-geico-com-claims-claimsprocess-vehicle-rental.txt (2788 chars)
- SAVED: https://www.geico.com/auto-insurance/mechanical-breakdown-insurance/ -> pages/11-www-geico-com-auto-insurance-mechanical-breakdown-insurance.txt (8327 chars)
- SAVED: https://www.geico.com/auto-insurance/comparison/ -> pages/12-www-geico-com-auto-insurance-comparison.txt (8266 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/shopping-for-car-insurance/ -> pages/13-www-geico-com-information-aboutinsurance-auto-shopping-for-car-insurance.txt (7883 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/determining-premiums/ -> pages/14-www-geico-com-information-aboutinsurance-auto-determining-premiums.txt (10120 chars)
- SAVED: https://www.geico.com/information/states/ -> pages/15-www-geico-com-information-states.txt (7346 chars)
- SAVED: https://www.geico.com/coverage-calculator/ -> pages/16-www-geico-com-coverage-calculator.txt (11489 chars)
- SAVED: https://www.geico.com/contact-us/ -> pages/17-www-geico-com-contact-us.txt (254 chars)
- SAVED: https://www.geico.com/web-and-mobile/mobile-apps/ -> pages/18-www-geico-com-web-and-mobile-mobile-apps.txt (4465 chars)
- SAVED: https://www.geico.com/auto-insurance/cheap-auto-insurance/ -> pages/19-www-geico-com-auto-insurance-cheap-auto-insurance.txt (8810 chars)
- SAVED: https://www.geico.com/save/discounts/multi-policy-insurance-discount/ -> pages/20-www-geico-com-save-discounts-multi-policy-insurance-discount.txt (6310 chars)
- SAVED: https://geico.app.link/static/GEICOApp -> pages/21-geico-app-link-static-geicoapp.txt (4465 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/liability-insurance/ -> pages/22-www-geico-com-information-aboutinsurance-auto-liability-insurance.txt (10413 chars)
- SAVED: https://www.geico.com/information/aboutinsurance/auto/car-insurance-deductibles/ -> pages/23-www-geico-com-information-aboutinsurance-auto-car-insurance-deductibles.txt (5045 chars)
- SAVED: https://www.geico.com/auto-insurance/states/ -> pages/24-www-geico-com-auto-insurance-states.txt (7346 chars)
