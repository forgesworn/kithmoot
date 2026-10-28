# Security

## Report a problem privately

If you find a way to read room content you shouldn't, to run code on someone else's device, to make the desktop app reach something it shouldn't, or to get a false update accepted, report it privately:

https://github.com/forgesworn/kithmoot/security/advisories/new

Please don't open a public issue for these. Only the project's maintainers see a private report, and you can discuss it with them in the same place until a fix is out. Problems in the Android app can be reported here too.

An ordinary bug, or a connection the app makes that [Check it yourself](https://kithmoot.app/check/) doesn't list, can go in a [public issue](https://github.com/forgesworn/kithmoot/issues).

## Which versions get fixes

Only the current release of the web app, the desktop app and the Android app. Update to it before reporting, if you can.

## What the apps are meant to do

[Check it yourself](https://kithmoot.app/check/) lists everything the desktop app connects to and can touch on your computer, with a command to check each claim. Anything it does beyond that list is a bug.

## Further reading

- [Security review, 15 October 2026](SECURITY-REVIEW-2026-10-15.md): a review of everything changed since the 20 September review, covering group encryption, browser-link pairing, credential vaults and live-meeting admission.
- [Security remediation, 15 October 2026](SECURITY-REMEDIATION-2026-10-15.md): the fix list for that review's three findings, and where each fix landed.
